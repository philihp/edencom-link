import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for market-adjusted-prices — the same thin-trigger shape
// as /api/cron/industry-systems: verify the secret, start() the workflow,
// return. The workflow owns retries and the heartbeat pair.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { marketAdjustedPricesWorkflow } = await import('@/workflows/marketAdjustedPrices')
  const run = await start(marketAdjustedPricesWorkflow, [])
  console.log(`[cron/market-adjusted-prices] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
