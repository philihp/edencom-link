import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-industry-jobs. Formerly fanned out one queue
// message per scoped character (fanOutPerCharacterCronJob); it now start()s the
// character-industry-jobs Vercel Workflow (src/workflows/characterIndustryJobs.ts),
// which enumerates the scoped characters itself and runs one step per character
// across a few lanes. Only the scheduled path moves — the on-demand "Refresh ESI"
// flow still enqueues this job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterIndustryJobsWorkflow } = await import('@/workflows/characterIndustryJobs')
  const run = await start(characterIndustryJobsWorkflow, [])
  console.log(`[cron/character-industry-jobs] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
