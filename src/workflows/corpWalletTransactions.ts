// corp-wallet-transactions as a Vercel Workflow — phase 4, PR 1 of the cron →
// Workflows migration (docs/cron-to-workflows/04-per-corporation.md). The first
// per-corporation fan-out job to migrate, establishing the shape the two corp
// reconcilers (corp-industry-jobs, corp-assets) copy.
//
// The fan-out unit is a *corp group*, not a character: enumerateCorporations
// (src/workflows/lib.ts) returns the same set fanOutPerCorporationCronJob sends
// today — one group per corporation (the ordered character list
// forEachCorporation dedupes to one handler call and falls back through on an
// in-game-role failure) plus a singleton group per unresolved character. A
// corp's characters ride together in one step; a corp is NEVER split across
// steps — two concurrent reconciles of the same corp once corrupted the SCD-2
// data, and "one step per corp, never two concurrent for the same corp" is now
// control flow instead of a queue-shape convention.
//
// This particular job is the safe one to lead with: corp_wallet_transaction is a
// keyed append (per division), no SCD-2 reconcile, so a concurrent or retried
// run is harmlessly idempotent. It proves the per-corp enumeration + step shape
// before the reconcilers follow.
//
// Formerly the cron route fanned out one Vercel queue message per corporation
// (fanOutPerCorporationCronJob); it now start()s this workflow. Only the
// *scheduled* trigger moves — the on-demand "Refresh ESI" path
// (dispatchRefresh's PER_CORPORATION_JOBS) still enqueues one message per corp;
// the job module is CLI-runnable too.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCorporations } from './lib'

// This job's ESI scope, and the lane count. Only *different* corps run
// concurrently (each corp's rows are disjoint); two lanes because the corp count
// is small and corp pulls are the heaviest. Even LANES = 1 (fully sequential)
// would be acceptable — it's a per-file constant, tune if the daily window says
// so.
const SCOPE = 'esi-wallet.read_corporation_wallets.v1'
const LANES = 2

// Step: run the job for one corp group. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCorporation still refreshes tokens, dedupes to one handler call
// per corp, falls back through the group on a role failure, and records the
// per-corp heartbeat pair — all unchanged. characterIds (registration uuids) is
// the only thing crossing the step boundary, and serializable.
async function syncCorporation(characterIds: string[]) {
  'use step'
  const { runCorpWalletTransactions } = await import('@/jobs/corpWalletTransactions.js')
  await runCorpWalletTransactions({ characterIds })
}

export async function corpWalletTransactionsWorkflow() {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: referentially transparent, no Node imports.
  const groups = await enumerateCorporations(SCOPE)

  // Round-robin the corp groups into LANES lanes (splitEvery chunks rows of
  // LANES, transpose flips rows→columns, so group i lands in lane i % LANES with
  // no empty trailing lanes). The mapping is identical on every replay. Within a
  // lane groups run sequentially; lanes run concurrently — and lanes only ever
  // parallelize *different* corps, never the same corp.
  const lanes = transpose(splitEvery(LANES, groups))

  // Drain each lane sequentially (the forEachSequential promise-chain, inlined
  // because src/jobs/lib.js can't be imported into workflow context). A group
  // whose step exhausts its bounded retries is caught (and logged) and
  // collected, then once every lane drains the failures are thrown together as
  // an AggregateError so the run is visibly failed in Observability without
  // aborting lane-mates. All groups are attempted regardless.
  const failures: string[][] = []
  const drainLane = (lane: string[][]): Promise<void> =>
    reduce(
      (p, group) =>
        p.then(() =>
          syncCorporation(group).catch((err) => {
            console.error(`[corp-wallet-transactions] corp group [${group.join(', ')}] failed:`, err)
            failures.push(group)
          }),
        ),
      Promise.resolve(),
      lane,
    )
  await Promise.all(map(drainLane, lanes))

  if (failures.length > 0) {
    throw new AggregateError(
      map((group) => new Error(`corp group [${group.join(', ')}] failed`), failures),
      `corp-wallet-transactions: ${failures.length} corp step(s) failed`,
    )
  }
}
