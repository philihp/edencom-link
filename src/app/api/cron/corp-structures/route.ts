import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for corp-structures. Formerly ran the job inline
// (runDirectCronJob); it now start()s the corp-structures Vercel Workflow
// (src/workflows/corpStructures.ts). Fire-and-forget: the workflow owns
// retries, its run/step status shows under Observability → Workflows, and the
// heartbeat pair is recorded by the workflow's step (source: 'vercel-workflow').
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { corpStructuresWorkflow } = await import('@/workflows/corpStructures')
  const run = await start(corpStructuresWorkflow, [])
  console.log(`[cron/corp-structures] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
