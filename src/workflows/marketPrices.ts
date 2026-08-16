// market-prices as a Vercel Workflow. Whole-universe work against a public
// third-party feed (appraise.gnf.lt), no per-character tokens — so it's closest
// to industry-systems, except that each tracked market gets its own step: a
// market's feed is ~11 MB and its reconcile touches 20k+ rows, which is
// comfortable inside one step but not stacked into one. Splitting also means a
// market the service is having trouble with doesn't cost the others their hour,
// and adding a market to TRACKED_MARKETS doesn't push the run toward a budget.
//
// The heartbeat therefore can't come from runJobWithHeartbeat (which wraps a
// single call): the pair is opened by its own step and closed by a finalize
// step, the same explicit shape sdeMirror.ts uses for the same reason. A failed
// run still closes its heartbeat before rethrowing — latest_heartbeats() only
// sees completed runs, so an open heartbeat would leave /jobs reporting the
// last *successful* run's age.
//
// The value imports live inside the step bodies on purpose: the workflow
// compiler bans Node modules in workflow context and traces every import
// reachable from it, but treats imports written inside a `'use step'` function
// as running in Node. See src/workflows/lib.ts.

import { map, reduce } from 'ramda'

import type { OnDemandTarget } from './lib'

// Step: open the run's heartbeat and resolve which markets to pull. Returns
// both so the workflow body stays deterministic control flow over step results
// (the market list is a module constant, but reading it in workflow context
// would pull the job module's Node imports in with it).
async function planRun(taskId?: string): Promise<{ runId: number; markets: string[] }> {
  'use step'
  const { randomInt } = await import('node:crypto')
  const { recordHeartbeat } = await import('@/supabase.js')
  const { markTaskRunning } = await import('./lib')
  const { TRACKED_MARKETS } = await import('@/gnfMarket.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('market-prices', 'start', { runId, source: 'vercel-workflow' })
  if (taskId !== undefined) await markTaskRunning(taskId)
  return { runId, markets: [...TRACKED_MARKETS] }
}

// Step: pull and reconcile one market. Idempotent — the SCD-2 reconcile
// converges, so the step's bounded retries are safe. The fetch refuses a
// truncated feed before any row is touched (MIN_PLAUSIBLE_TYPES), so a partial
// upstream response fails the step rather than reading as a mass delisting.
async function syncMarket(market: string) {
  'use step'
  const { syncMarketPrices } = await import('@/jobs/marketPrices.js')
  await syncMarketPrices(market)
}

// Step: close the run's heartbeat. ok:false carries the failure message so
// /jobs shows the run as failed rather than merely old.
async function finalizeRun(runId: number, taskId?: string, error?: string) {
  'use step'
  const { recordHeartbeat } = await import('@/supabase.js')
  const { recordPeakRss } = await import('@/observability.js')
  const { markTaskSettled } = await import('./lib')
  recordPeakRss({ job: 'market-prices' })
  await recordHeartbeat('market-prices', 'end', {
    runId,
    source: 'vercel-workflow',
    ok: error === undefined,
    ...(error === undefined ? {} : { error }),
  })
  // Settled alongside the heartbeat rather than around the run: the run is a
  // fan-out, so there is no single call for withRefreshTask to wrap.
  if (taskId !== undefined) await markTaskSettled(taskId, error === undefined ? undefined : new Error(error))
}

export async function marketPricesWorkflow(target?: OnDemandTarget) {
  'use workflow'
  const { runId, markets } = await planRun(target?.taskId)

  // Markets run sequentially (the promise-chain reduce the fan-out workflows
  // use, inlined because src/jobs/lib.js can't be imported into workflow
  // context): the feed is one service's, and two concurrent 11 MB pulls buy
  // nothing but a heavier hand on someone else's bandwidth. A failing market is
  // caught and collected so its siblings still run, then thrown together at the
  // end so the run is visibly failed in Observability.
  const failures: string[] = []
  await reduce(
    (p: Promise<void>, market: string) =>
      p.then(() =>
        syncMarket(market).catch((err) => {
          console.error(`[market-prices] market ${market} failed:`, err)
          failures.push(market)
        })
      ),
    Promise.resolve(),
    markets
  )

  const summary = failures.length > 0 ? `market-prices: ${failures.length} market step(s) failed` : undefined
  await finalizeRun(runId, target?.taskId, summary)

  if (failures.length > 0) {
    throw new AggregateError(
      map((market) => new Error(`market ${market} failed`), failures),
      summary
    )
  }
}
