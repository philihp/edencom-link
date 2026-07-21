import { NextRequest, NextResponse } from 'next/server'

import { dispatchAccountCronJob, requireCronSecret } from '@/utils/cron'

// Cron entry for the character-directory extract (subsumes the retired
// character-affiliations job). Account-wide batch work (no character scope), so
// it dispatches a single queue message; the consumer records its own whole-job
// heartbeat.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  await dispatchAccountCronJob('character-directory')

  return NextResponse.json({ ok: true })
}
