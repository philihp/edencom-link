import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for public-contracts (every 15 minutes). Fire-and-forget:
// the workflow owns retries, its run/step status shows under Observability →
// Workflows, and the heartbeat pair is recorded by the workflow's step
// (source: 'vercel-workflow').
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { publicContractsWorkflow } = await import('@/workflows/publicContracts')
  const run = await start(publicContractsWorkflow, [])
  console.log(`[cron/public-contracts] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
