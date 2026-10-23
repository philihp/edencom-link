// market-prices as a Vercel Workflow. Whole-universe work against a public
// third-party feed (appraise.gnf.lt), no per-character tokens, so the
// single-step shape: runJobWithHeartbeat wraps runMarketPrices in the
// start/end heartbeat pair, gaining the per-step duration budget and bounded
// retries. runMarketPrices pulls the tracked markets one after another, which
// keeps the "one service, no concurrent ~11 MB pulls" property. A failing
// market fails the step and its retry re-runs both, which is safe: the SCD-2
// reconcile converges, and the fetch refuses a truncated feed
// (MIN_PLAUSIBLE_TYPES) before any row is touched.
//
// The value imports live inside the step body on purpose (see
// src/workflows/lib.ts): the workflow compiler bans Node modules in workflow
// context but treats imports inside a 'use step' function as running in Node.

import type { OnDemandTarget } from './lib'

async function runStep(taskId?: string) {
  'use step'
  const { runJobWithHeartbeat, withRefreshTask } = await import('./lib')
  await withRefreshTask(taskId, () =>
    runJobWithHeartbeat('market-prices', async () => (await import('@/jobs/marketPrices.js')).runMarketPrices)
  )
}

export async function marketPricesWorkflow(target?: OnDemandTarget) {
  'use workflow'
  await runStep(target?.taskId)
}
