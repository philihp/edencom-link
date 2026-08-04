import { randomInt } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

// Shared plumbing for the /api/cron/* routes that replaced the old per-job
// GitHub Actions schedules. Vercel signs cron requests with a
// `Authorization: Bearer $CRON_SECRET` header (see vercel.json's `crons`
// entries), so every route checks that instead of trusting the request.
export const requireCronSecret = (request: NextRequest): NextResponse | null => {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

// Run a job inline in the cron function and wrap it in a start/end heartbeat.
// Every *scheduled* extract job has moved to a Vercel Workflow (the cron →
// Workflows migration, docs/cron-to-workflows/ — runJobWithHeartbeat in
// src/workflows/lib.ts is this helper's workflow-shaped counterpart); the only
// remaining callers are the unscheduled manual/bootstrap routes for the
// SDE-derived encodes, /api/cron/esf-data and /api/cron/sheet-csv, which run
// small enough to live inside the route's own invocation.
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
