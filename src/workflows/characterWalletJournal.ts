// character-wallet-journal as a Vercel Workflow: the per-character fan-out shape
// characterWalletTransactions.ts established, for the character wallet journal
// (src/jobs/characterWalletJournal.js). Both triggers start() it — the cron
// route bare, and the on-demand "Refresh ESI" path with an OnDemandTarget. The
// job is paged and unconditional, so there is no ETag step here; everything
// per-character (token refresh, heartbeat pair, upsert) stays in the job module.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCharacters, type OnDemandTarget } from './lib'
import { bySlot, runStartSeconds, waitForSlot } from './stagger'

// This job's ESI scope, and the lane count. Four lanes keeps a big account
// polite to ESI's error-rate limits (the queue already ran per-character pulls
// concurrently, so this is nothing new); it's a per-file constant, tune per job
// if heartbeat durations say so.
const SCOPES = ['esi-wallet.read_character_wallet.v1']
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
  const { runCharacterWalletJournal } = await import('@/jobs/characterWalletJournal.js')
  await withRefreshTask(taskId, () => runCharacterWalletJournal({ registrationIds: [registrationId] }))
}

export async function characterWalletJournalWorkflow(target?: OnDemandTarget) {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: they're referentially transparent (identical on
  // every replay) and pull in no Node modules, unlike a workflow-level helper
  // that would run impure/Node code in workflow context.
  // A scheduled run (the cron route starts it with no target) staggers its
  // characters: each lane sleeps until a character's second of the hour, then
  // runs that character's step, then sleeps until the next one's (./stagger).
  // One sleep and one step per character, all inside this run. An on-demand run
  // (with a target) is not staggered and starts at once.
  const ids = target?.registrationIds ?? (await enumerateCharacters(SCOPES))
  const staggered = target === undefined
  const startSeconds = runStartSeconds()
  const awaitTurn = (id: string): Promise<void> => (staggered ? waitForSlot(id, startSeconds) : Promise.resolve())

  // Round-robin the characters into LANES lanes: splitEvery chunks the ids into
  // rows of LANES, then transpose flips rows→columns, so id i lands in lane
  // i % LANES, with no empty trailing lanes when there are fewer ids than lanes.
  // A staggered run sorts the ids by slot first (bySlot), so every lane walks the
  // hour forwards and each stretch of the hour is spread across the lanes. Both
  // depend only on the ids and the run's start, so every replay derives the same
  // lanes. Within a lane characters run sequentially; lanes run concurrently.
  const lanes = transpose(splitEvery(LANES, staggered ? bySlot(ids, startSeconds) : ids))

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
        p
          .then(() => awaitTurn(id))
          .then(() =>
            syncCharacter(id, target?.taskId).catch((err) => {
              console.error(`[character-wallet-journal] character ${id} failed:`, err)
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
      `character-wallet-journal: ${failures.length} character step(s) failed`
    )
  }
}
