import { randomInt } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

// Vercel Cron replacement for the old `industry-systems.yml` GitHub Action, which
// wasn't firing reliably every hour. Vercel signs cron requests with a
// `Authorization: Bearer $CRON_SECRET` header (see vercel.json's `crons` entry),
// so verify that instead of trusting the request.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { runIndustrySystems } = await import('@/jobs/industrySystems.js')
  const { recordHeartbeat } = await import('@/supabase.js')

  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('industry-systems', 'start', { runId, source: 'vercel-cron' })
  try {
    await runIndustrySystems()
  } finally {
    await recordHeartbeat('industry-systems', 'end', { runId, source: 'vercel-cron' })
  }

  return NextResponse.json({ ok: true })
}
