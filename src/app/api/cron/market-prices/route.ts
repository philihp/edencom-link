import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for market-prices (hourly). Thin trigger, same shape as
// /api/cron/industry-systems: it start()s the market-prices Vercel Workflow
// (src/workflows/marketPrices.ts) and returns. Fire-and-forget — the workflow
// owns retries, its run/step status shows under Observability → Workflows, and
// the heartbeat pair is recorded by the workflow's step.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { marketPricesWorkflow } = await import('@/workflows/marketPrices')
  const run = await start(marketPricesWorkflow, [])
  console.log(`[cron/market-prices] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
