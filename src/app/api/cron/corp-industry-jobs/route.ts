import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for corp-industry-jobs. Formerly fanned out one queue
// message per corporation (fanOutPerCorporationCronJob); it now start()s the
// corp-industry-jobs Vercel Workflow (src/workflows/corpIndustryJobs.ts), which
// groups the scoped characters by corporation itself and runs one step per corp
// across a couple of lanes. Only the scheduled path moves — the on-demand
// "Refresh ESI" flow still enqueues one message per corp via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { corpIndustryJobsWorkflow } = await import('@/workflows/corpIndustryJobs')
  const run = await start(corpIndustryJobsWorkflow, [])
  console.log(`[cron/corp-industry-jobs] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
