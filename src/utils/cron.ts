import { randomInt } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

// Shared plumbing for the /api/cron/* routes that replaced the old per-job
// GitHub Actions schedules. Vercel signs cron requests with a
// `Authorization: Bearer $CRON_SECRET` header (see vercel.json's `crons`
// entries), so every route checks that instead of trusting the request.
//
// This used to also hold the queue dispatch shapes (fanOutPerCharacterCronJob /
// fanOutPerCharacterAnyScopeCronJob, fanOutPerCorporationCronJob,
// dispatchAccountCronJob) that fanned the scheduled jobs out over the Vercel
// queue. Phases 1–4 of the cron → Workflows migration (docs/cron-to-workflows/)
// moved every scheduled job onto a start()ed workflow under src/workflows/,
// and phase 5 moved the on-demand "Refresh ESI" path onto the same workflows
// (dispatchRefresh.ts), so those helpers — and the queue consumer they fed —
// are gone.
export const requireCronSecret = (request: NextRequest): NextResponse | null => {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

// Run a job inline in the calling route, wrapped in a start/end heartbeat pair.
// The scheduled extract jobs all outgrew this (they run as workflows now — see
// above); it survives only for the deliberately unscheduled manual bootstrap
// routes (/api/cron/esf-data, /api/cron/sheet-csv), whose whole point is a
// small inline run under the caller's own invocation.
export const runDirectCronJob = async (job: string, run: () => Promise<unknown>) => {
  const { recordHeartbeat } = await import('@/supabase.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat(job, 'start', { runId, source: 'vercel-cron' })
  try {
    await run()
  } finally {
    await recordHeartbeat(job, 'end', { runId, source: 'vercel-cron' })
  }
}
