import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for anon-sweep: deletes the anonymous accounts every
// visitor arrives on and never converts (docs/open-registration.md). Thin
// trigger — it start()s the workflow (src/workflows/anonSweep.ts), which owns
// retries and records the heartbeat pair.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { anonSweepWorkflow } = await import('@/workflows/anonSweep')
  const run = await start(anonSweepWorkflow, [])
  console.log(`[cron/anon-sweep] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
