import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCorporationCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-assets.read_corporation_assets.v1'

// Vercel Cron replacement for the old `corp-assets.yml` GitHub Action. Fans out one
// Vercel queue message per corporation (deduped across its scoped characters — see
// fanOutPerCorporationCronJob), so this stays within the function duration limit
// regardless of account size without risking two concurrent reconciles racing for
// the same corp.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCorporationCronJob('corp-assets', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
