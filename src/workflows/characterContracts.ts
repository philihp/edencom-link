// character-contracts as a Vercel Workflow — the per-character fan-out shape
// established by characterWalletTransactions.ts, which this copies: the cron
// route start()s it bare and it enumerates the scoped characters itself
// (enumerateCharacters step), while the on-demand "Refresh ESI" path
// (dispatchRefresh's PER_CHARACTER_JOBS) start()s it with an OnDemandTarget —
// the one character to run plus its refresh_task row — which skips enumeration.
// Everything per-character (token refresh, the heartbeat pair, the paged
// contracts pull, the bounded per-contract item backlog) stays inside the job
// module, which is CLI-runnable too.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCharacters, type OnDemandTarget } from './lib'

// This job's ESI scope, and the lane count. Four lanes matches the other
// per-character jobs; a character's step is one paged contracts call plus up to
// MAX_ITEM_FETCHES small item calls, so the lanes stay polite to ESI's
// error-rate limits.
const SCOPES = ['esi-contracts.read_character_contracts.v1']
const LANES = 4

// Step: run the job for one character. Lazy import for the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). withRefreshTask is a passthrough without a taskId and best-effort
// refresh_task status tracking with one (see ./lib).
async function syncCharacter(registrationId: string, taskId?: string) {
  'use step'
  const { withRefreshTask } = await import('./lib')
  const { runCharacterContracts } = await import('@/jobs/characterContracts.js')
  await withRefreshTask(taskId, () => runCharacterContracts({ registrationIds: [registrationId] }))
}

export async function characterContractsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  // The workflow body stays deterministic control flow over step calls; ramda's
  // pure combinators are safe here (referentially transparent, no Node imports).
  const ids = target?.registrationIds ?? (await enumerateCharacters(SCOPES))

  // Round-robin the characters into LANES lanes (splitEvery chunks rows of
  // LANES, transpose flips rows→columns, so id i lands in lane i % LANES with no
  // empty trailing lanes). Identical on every replay. Within a lane characters
  // run sequentially; lanes run concurrently.
  const lanes = transpose(splitEvery(LANES, ids))

  // Drain each lane sequentially (the forEachSequential promise-chain, inlined
  // because src/jobs/lib.js can't be imported into workflow context). A failing
  // character is caught, logged and collected so it doesn't abort its
  // lane-mates, then every failure is rethrown together as an AggregateError so
  // the run is visibly failed in Observability.
  const failures: string[] = []
  const drainLane = (lane: string[]): Promise<void> =>
    reduce(
      (p, id) =>
        p.then(() =>
          syncCharacter(id, target?.taskId).catch((err) => {
            console.error(`[character-contracts] character ${id} failed:`, err)
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
      `character-contracts: ${failures.length} character step(s) failed`
    )
  }
}
