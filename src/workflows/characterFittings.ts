// character-fittings as a Vercel Workflow, in the per-character fan-out shape
// phase 3 of the cron → Workflows migration established
// (docs/cron-to-workflows/03-per-character.md). Every per-character extract
// added since that phase starts here rather than on the queue's scheduled path;
// the only per-job differences are the scope, the label, and the job module.
//
// The cron route start()s this workflow, which enumerates the scoped characters
// itself (enumerateCharacters step) and runs one step per character across a few
// statically assigned lanes. Everything per-character — token refresh, the
// per-character heartbeat pair, the conditional GET and the SCD-2 reconcile —
// stays inside the job module (runCharacterFittings → forEachCharacter in
// src/jobs/lib.js).
//
// Only the *scheduled* trigger lives here. The on-demand "Refresh ESI" path
// (dispatchRefresh's PER_CHARACTER_JOBS) enqueues this job through the queue;
// the job module is CLI-runnable too.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { type OnDemand, enumerateCharacters, markRefreshTask } from './lib'

// This job's ESI scope, and the lane count. Four lanes matches the sibling
// per-character workflows; a fitting pull is one conditional GET per character,
// usually answered 304, so this is among the cheapest of them.
const SCOPES = ['esi-fittings.read_fittings.v1']
const LANES = 4

// Step: run the job for one character. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCharacter still refreshes the token and records the
// per-character heartbeat pair, unchanged. registrationId is a registration
// uuid — the only thing crossing the step boundary, and serializable.
async function syncCharacter(registrationId: string) {
  'use step'
  const { runCharacterFittings } = await import('@/jobs/characterFittings.js')
  await runCharacterFittings({ registrationIds: [registrationId] })
}

export async function characterFittingsWorkflow(onDemand?: OnDemand) {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: they're referentially transparent (identical on
  // every replay) and pull in no Node modules.
  if (onDemand?.taskId) await markRefreshTask(onDemand.taskId, 'running')

  // An on-demand run arrives with its target pre-enumerated (the one character
  // a refresh cell kicked); a scheduled run enumerates every scoped character.
  const ids = onDemand?.registrationIds ?? (await enumerateCharacters(SCOPES))

  // Round-robin the characters into LANES lanes: splitEvery chunks the ids into
  // rows of LANES, then transpose flips rows→columns, so column j collects every
  // id at position j, j+LANES, … — i.e. id i lands in lane i % LANES, with no
  // empty trailing lanes when there are fewer ids than lanes. The mapping is
  // identical on every replay. Within a lane characters run sequentially; lanes
  // run concurrently.
  const lanes = transpose(splitEvery(LANES, ids))

  // Drain each lane sequentially (the forEachSequential promise-chain, inlined
  // because src/jobs/lib.js can't be imported into workflow context). A step that
  // exhausts its bounded retries should be *visible* rather than silently
  // re-looped, but must not abort its lane-mates — so each failure is caught and
  // collected, and once every lane drains the collected ids are thrown together
  // as an AggregateError, marking the run failed in Observability.
  const failures: string[] = []
  const drainLane = (lane: string[]): Promise<void> =>
    reduce(
      (p, id) =>
        p.then(() =>
          syncCharacter(id).catch((err) => {
            console.error(`[character-fittings] character ${id} failed:`, err)
            failures.push(id)
          })
        ),
      Promise.resolve(),
      lane
    )
  await Promise.all(map(drainLane, lanes))

  if (failures.length > 0) {
    if (onDemand?.taskId) await markRefreshTask(onDemand.taskId, 'error', `${failures.length} character step(s) failed`)
    throw new AggregateError(
      map((id) => new Error(`character ${id} failed`), failures),
      `character-fittings: ${failures.length} character step(s) failed`
    )
  }

  if (onDemand?.taskId) await markRefreshTask(onDemand.taskId, 'done')
}
