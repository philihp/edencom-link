// character-skills as a per-character fan-out Vercel Workflow, following the
// phase-3 shape the scheduled per-character jobs use (characterOrders.ts,
// characterStatus.ts, …) rather than the since-retired single-step
// character-implants pilot. The trigger route start()s this workflow,
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
import { waitForSlot } from './stagger'

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

// Step: start this workflow again as a staggered child run for one character
// (see ./stagger). One step per character, so a retry can start again only
// that one run.
async function dispatchCharacter(registrationId: string) {
  'use step'
  const { start } = await import('workflow/api')
  const { characterSkillsWorkflow } = await import('./characterSkills')
  const run = await start(characterSkillsWorkflow, [{ registrationIds: [registrationId], staggered: true }])
  console.log(`[character-skills] character ${registrationId}: dispatched run=${run.runId}`)
}

export async function characterSkillsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: they're referentially transparent (identical on
  // every replay) and pull in no Node modules, unlike a workflow-level helper
  // that would run impure/Node code in workflow context.
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
          syncCharacter(id, target.taskId).catch((err) => {
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
