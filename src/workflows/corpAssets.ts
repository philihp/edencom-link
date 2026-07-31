// corp-assets as a Vercel Workflow — phase 4, PR 3 (the last) of the cron →
// Workflows migration (docs/cron-to-workflows/04-per-corporation.md). Copies the
// per-corporation fan-out shape corpWalletTransactions.ts established; the only
// differences are the scope, the job label, and the job module it loads.
//
// This is the original race victim, and the last job in the whole migration:
// biggest volume, paginated corp hangars, an SCD-2 reconcile
// (corp_asset_over_time) plus corp_structure_rig, the most user-visible corp
// data. It goes last, deliberately, after the fan-out pattern has run in
// production. The migration makes the safety structural: a corp's characters
// ride together in one step (never split — see enumerateCorporations in lib.ts
// and the concurrent-reconcile history), only *different* corps run concurrently
// across lanes, and a retried step just converges. All the paging + reconcile
// stays inside the untouched job module (runCorpAssets → forEachCorporation in
// src/jobs/lib.js). If a corp's step ever trends toward its duration budget, the
// escape hatch is the sde-mirror cursor-slice pattern inside the job — a later,
// separate change.
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
// is small and corp pulls are the heaviest (paginated hangars). Even LANES = 1
// (fully sequential) would be acceptable — it's a per-file constant, tune if the
// daily window says so.
const SCOPE = 'esi-assets.read_corporation_assets.v1'
const LANES = 2

// Step: run the job for one corp group. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCorporation still refreshes tokens, dedupes to one handler call
// per corp, falls back through the group on a role failure, and records the
// per-corp heartbeat pair — all unchanged. characterIds (registration uuids) is
// the only thing crossing the step boundary, and serializable.
async function syncCorporation(characterIds: string[]) {
  'use step'
  const { runCorpAssets } = await import('@/jobs/corpAssets.js')
  await runCorpAssets({ characterIds })
}

export async function corpAssetsWorkflow() {
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
            console.error(`[corp-assets] corp group [${group.join(', ')}] failed:`, err)
            failures.push(group)
          })
        ),
      Promise.resolve(),
      lane
    )
  await Promise.all(map(drainLane, lanes))

  if (failures.length > 0) {
    throw new AggregateError(
      map((group) => new Error(`corp group [${group.join(', ')}] failed`), failures),
      `corp-assets: ${failures.length} corp step(s) failed`
    )
  }
}
