import { NextRequest, NextResponse } from 'next/server'

import { dispatchAccountCronJob, requireCronSecret } from '@/utils/cron'

// Vercel Cron replacement for the old `character-affiliations.yml` GitHub Action.
// Account-wide batch work (no character scope), so it dispatches a single queue
// message; the consumer records its own whole-job heartbeat.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  await dispatchAccountCronJob('character-affiliations')

  return NextResponse.json({ ok: true })
}
