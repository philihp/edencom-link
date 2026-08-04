// corp-industry-jobs as a Vercel Workflow — phase 4, PR 2 of the cron →
// Workflows migration (docs/cron-to-workflows/04-per-corporation.md). Copies the
// per-corporation fan-out shape corpWalletTransactions.ts established; the only
// differences are the scope, the job label, and the job module it loads.
//
// Unlike the wallet-transactions leader, this is a real SCD-2 reconciler
// (corp_industry_job_over_time) — modest volume, but a botched reconcile closes
// rows that never reopen. The migration makes that *safer*: "one step per corp,
// never two concurrent for the same corp" is now control flow. A corp's
// characters ride together in one step (never split — see enumerateCorporations
// in lib.ts and the race history), and only *different* corps run concurrently
// across lanes; a retried step just converges (the incident was concurrent
// reconciles, not re-runs). All the reconcile logic stays inside the untouched
// job module (runCorpIndustryJobs → forEachCorporation in src/jobs/lib.js).
//
// Formerly the cron route fanned out one Vercel queue message per corporation
// (fanOutPerCorporationCronJob). Both triggers start() this workflow now
// (phase 5): the cron route starts it bare, and the on-demand "Refresh ESI"
// path (dispatchRefresh's PER_CORPORATION_JOBS) starts it with an OnDemandTarget — one corp's whole
// character group plus its refresh_task row, tracked running → done/error
// inside the step — which skips enumeration. The job module is CLI-runnable
// too.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCorporations, type OnDemandTarget } from './lib'

// This job's ESI scope, and the lane count. Only *different* corps run
// concurrently (each corp's rows are disjoint); two lanes because the corp count
// is small and corp pulls are the heaviest. Even LANES = 1 (fully sequential)
// would be acceptable — it's a per-file constant, tune if the daily window says
// so.
const SCOPE = 'esi-industry.read_corporation_jobs.v1'
const LANES = 2

// Step: run the job for one corp group. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCorporation still refreshes tokens, dedupes to one handler call
// per corp, falls back through the group on a role failure, and records the
// per-corp heartbeat pair — all unchanged. registrationIds (registration uuids)
// and the optional refresh_task id are all that cross the step boundary,
// serializable. withRefreshTask is a passthrough without a taskId and
// best-effort refresh_task status tracking with one (see ./lib).
async function syncCorporation(registrationIds: string[], taskId?: string) {
  'use step'
  const { withRefreshTask } = await import('./lib')
  const { runCorpIndustryJobs } = await import('@/jobs/corpIndustryJobs.js')
  await withRefreshTask(taskId, () => runCorpIndustryJobs({ registrationIds }))
}

export async function corpIndustryJobsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: referentially transparent, no Node imports.
  const groups = target?.registrationIds ? [target.registrationIds] : await enumerateCorporations(SCOPE)

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
          syncCorporation(group, target?.taskId).catch((err) => {
            console.error(`[corp-industry-jobs] corp group [${group.join(', ')}] failed:`, err)
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
      `corp-industry-jobs: ${failures.length} corp step(s) failed`
    )
  }
}
