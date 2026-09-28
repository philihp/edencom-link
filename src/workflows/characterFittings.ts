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
// Both triggers start() this workflow now (phase 5): the cron route starts it
// bare, and the on-demand "Refresh ESI" path (dispatchRefresh's
// PER_CHARACTER_JOBS) starts it with an OnDemandTarget — the one character to
// run plus its refresh_task row, tracked running → done/error inside the step
// — which skips enumeration. The job module is CLI-runnable too.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCharacters, type OnDemandTarget } from './lib'
import { waitForSlot } from './stagger'

// This job's ESI scope, and the lane count. Four lanes matches the sibling
// per-character workflows; a fitting pull is one conditional GET per character,
// usually answered 304, so this is among the cheapest of them.
const SCOPES = ['esi-fittings.read_fittings.v1']
const LANES = 4

// Step: run the job for one character. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCharacter still refreshes the token and records the
// per-character heartbeat pair, unchanged. registrationId is the registration
// uuid; it and the optional refresh_task id are all that cross the step
// boundary, both serializable. withRefreshTask is a passthrough without a
// taskId and best-effort refresh_task status tracking with one (see ./lib).
async function syncCharacter(registrationId: string, taskId?: string) {
  'use step'
  const { withRefreshTask } = await import('./lib')
  const { runCharacterFittings } = await import('@/jobs/characterFittings.js')
  await withRefreshTask(taskId, () => runCharacterFittings({ registrationIds: [registrationId] }))
}

// Step: start this workflow again as a staggered child run for one character
// (see ./stagger). One step per character, so a retry can start again only
// that one run.
async function dispatchCharacter(registrationId: string) {
  'use step'
  const { start } = await import('workflow/api')
  const { characterFittingsWorkflow } = await import('./characterFittings')
  const run = await start(characterFittingsWorkflow, [{ registrationIds: [registrationId], staggered: true }])
  console.log(`[character-fittings] character ${registrationId}: dispatched run=${run.runId}`)
}

export async function characterFittingsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: they're referentially transparent (identical on
  // every replay) and pull in no Node modules.
  // A scheduled run (the cron route starts it with no target) only fans out:
  // one child run per character. Each child sleeps in this workflow body until
  // its character's second of the hour, and only then do its lanes start. An
  // on-demand run is not staggered and starts at once.
  if (target === undefined) {
    await Promise.all(map(dispatchCharacter, await enumerateCharacters(SCOPES)))
    return
  }
  const ids = target.registrationIds ?? (await enumerateCharacters(SCOPES))
  if (target.staggered) await Promise.all(map(waitForSlot, ids))

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
          syncCharacter(id, target.taskId).catch((err) => {
            console.error(`[character-fittings] character ${id} failed:`, err)
            failures.push(id)
          })
        ),
      Promise.resolve(),
      lane
    )
  await Promise.all(map(drainLane, lanes))

  if (failures.length > 0) {
    throw new AggregateError(
      map((id) => new Error(`character ${id} failed`), failures),
      `character-fittings: ${failures.length} character step(s) failed`
    )
  }
}
