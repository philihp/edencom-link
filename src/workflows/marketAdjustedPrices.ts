// market-adjusted-prices as a Vercel Workflow — the same single-step shape as
// industry-systems: whole-universe work against a public ESI endpoint, no
// per-character tokens, so one step wrapping the job module in the heartbeat
// pair. The value imports live inside the step body on purpose (see
// src/workflows/lib.ts): the workflow compiler bans Node modules in workflow
// context but treats imports inside a 'use step' function as running in Node.

import type { OnDemandTarget } from './lib'

async function runStep(taskId?: string) {
  'use step'
  const { runJobWithHeartbeat, withRefreshTask } = await import('./lib')
  await withRefreshTask(taskId, () =>
    runJobWithHeartbeat(
      'market-adjusted-prices',
      async () => (await import('@/jobs/marketAdjustedPrices.js')).runMarketAdjustedPrices
    )
  )
}

export async function marketAdjustedPricesWorkflow(target?: OnDemandTarget) {
  'use workflow'
  await runStep(target?.taskId)
}
