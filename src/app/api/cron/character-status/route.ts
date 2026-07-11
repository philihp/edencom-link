import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCharacterAnyScopeCronJob, requireCronSecret } from '@/utils/cron'

// The combined character-status job's four ESI scopes (wallet, location,
// implants, clones). Hardcoded rather than imported from the job module so this
// route stays free of the job's top-level service-client setup (which needs env
// vars absent at build time) — the same reason the queue consumer lazy-imports
// jobs. Keep in sync with SCOPES in src/jobs/characterStatus.js.
const SCOPES = [
  'esi-wallet.read_character_wallet.v1',
  'esi-location.read_location.v1',
  'esi-clones.read_implants.v1',
  'esi-clones.read_clones.v1',
]

// Vercel Cron entry for the combined character-status extract. Fans out one
// Vercel queue message per character carrying any of the four scopes, so this
// stays within the function duration limit regardless of account size. Replaces
// the separate character-wallet / character-location / character-implants /
// character-clones cron entries.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCharacterAnyScopeCronJob('character-status', SCOPES)

  return NextResponse.json({ ok: true, dispatched })
}
