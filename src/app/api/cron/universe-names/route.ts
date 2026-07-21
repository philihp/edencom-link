import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for universe-names. Formerly dispatched a single queue
// message (dispatchAccountCronJob) whose consumer ran the batch and recorded
// the whole-job heartbeat; it now start()s the universe-names Vercel Workflow
// (src/workflows/universeNames.ts), whose step runs the batch and records the
// pair (source: 'vercel-workflow'). Only the scheduled path moves — the
// on-demand "Refresh ESI" flow still enqueues this job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { universeNamesWorkflow } = await import('@/workflows/universeNames')
  const run = await start(universeNamesWorkflow, [])
  console.log(`[cron/universe-names] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
