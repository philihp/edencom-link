import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for industry-systems. Formerly ran the job inline
// (runDirectCronJob); it now start()s the industry-systems Vercel Workflow
// (src/workflows/industrySystems.ts) — the same thin-trigger shape as
// /api/cron/sde-mirror. Fire-and-forget: the workflow owns retries, its
// run/step status shows under Observability → Workflows, and the heartbeat
// pair is recorded by the workflow's step (source: 'vercel-workflow').
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { industrySystemsWorkflow } = await import('@/workflows/industrySystems')
  const run = await start(industrySystemsWorkflow, [])
  console.log(`[cron/industry-systems] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
