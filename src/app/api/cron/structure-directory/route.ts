import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for structure-directory (hourly). Fire-and-forget: the
// workflow owns retries, its run/step status shows under Observability →
// Workflows, and the heartbeat pair is recorded by the workflow's step
// (source: 'vercel-workflow').
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { structureDirectoryWorkflow } = await import('@/workflows/structureDirectory')
  const run = await start(structureDirectoryWorkflow, [])
  console.log(`[cron/structure-directory] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
