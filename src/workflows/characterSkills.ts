// character-skills as a per-character fan-out Vercel Workflow, following the
// phase-3 shape the scheduled per-character jobs use (characterOrders.ts,
// characterStatus.ts, …) rather than the older single-step character-implants
// pilot. The trigger route (/api/cron/character-skills) start()s this workflow,
// which enumerates the scoped characters itself (enumerateCharacters step) and
// runs one step per character across a few statically assigned lanes.
// Everything per-character — token refresh, the per-character heartbeat pair,
// the SCD-2 reconcile — stays inside the untouched job module
// (runCharacterSkills → forEachCharacter in src/jobs/lib.js).
//
// character-skills isn't independently scheduled (character-status covers skills
// on the schedule and calls syncCharacterSkills inline); this workflow backs the
// deliberately unscheduled manual trigger and any backfill run.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCharacters, type OnDemandTarget } from './lib'

// This job's ESI scope, and the lane count. Four lanes keeps a big account
// polite to ESI's error-rate limits; it's a per-file constant, tune per job if
// heartbeat durations say so.
const SCOPES = ['esi-skills.read_skills.v1']
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
  const { runCharacterSkills } = await import('@/jobs/characterSkills.js')
  await withRefreshTask(taskId, () => runCharacterSkills({ registrationIds: [registrationId] }))
}

export async function characterSkillsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: they're referentially transparent (identical on
  // every replay) and pull in no Node modules, unlike a workflow-level helper
  // that would run impure/Node code in workflow context.
  const ids = target?.registrationIds ?? (await enumerateCharacters(SCOPES))

  // Round-robin the characters into LANES lanes: splitEvery chunks the ids into
  // rows of LANES, then transpose flips rows→columns, so column j collects
  // every id at position j, j+LANES, … — i.e. id i lands in lane i % LANES, with
  // no empty trailing lanes when there are fewer ids than lanes. The mapping is
  // identical on every replay regardless of how the runtime resolves in-flight
  // steps. Within a lane characters run sequentially; lanes run concurrently.
  const lanes = transpose(splitEvery(LANES, ids))

  // Drain each lane sequentially (the forEachSequential promise-chain: reduce a
  // Promise.resolve() through the lane, each id awaiting the previous — inlined
  // because src/jobs/lib.js can't be imported into workflow context). A step
  // that exhausts its bounded retries (e.g. a character whose token is dead)
  // should be *visible*, not silently re-looped the way the queue did, but must
  // not abort its lane-mates — so each failure is caught (and logged as it
  // happens) and collected, then once every lane drains the collected ids are
  // mapped to one Error each and thrown together as an AggregateError, marking
  // the run failed in Observability. All characters are attempted regardless of
  // how the runtime treats a rejection inside Promise.all.
  const failures: string[] = []
  const drainLane = (lane: string[]): Promise<void> =>
    reduce(
      (p, id) =>
        p.then(() =>
          syncCharacter(id, target?.taskId).catch((err) => {
            console.error(`[character-skills] character ${id} failed:`, err)
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
      `character-skills: ${failures.length} character step(s) failed`
    )
  }
}
