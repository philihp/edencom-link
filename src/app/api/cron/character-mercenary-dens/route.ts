import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCharacterCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-structures.read_character.v1'

// Fans out one Vercel queue message per character carrying the mercenary-den
// scope, mirroring the on-demand "Refresh ESI" flow, so each invocation stays
// within the function duration limit regardless of account size.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCharacterCronJob('character-mercenary-dens', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
