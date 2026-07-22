import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Cron trigger for the character-directory extract (subsumes the retired
// character-affiliations job). Formerly dispatched a single queue message
// (dispatchAccountCronJob) whose consumer ran the batch and recorded the
// whole-job heartbeat; it now start()s the character-directory Vercel Workflow
// (src/workflows/characterDirectory.ts), whose step runs the batch and records
// the pair (source: 'vercel-workflow'). Only the scheduled path moves — the
// on-demand "Refresh ESI" flow still enqueues this job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterDirectoryWorkflow } = await import('@/workflows/characterDirectory')
  const run = await start(characterDirectoryWorkflow, [])
  console.log(`[cron/character-directory] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
