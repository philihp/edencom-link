import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCharacterCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-markets.read_character_orders.v1'

// Vercel Cron replacement for the old `character-orders.yml` GitHub Action. Fans out
// one Vercel queue message per scoped character, mirroring the on-demand "Refresh ESI"
// flow, so this stays within the function duration limit regardless of account size.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCharacterCronJob('character-orders', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
