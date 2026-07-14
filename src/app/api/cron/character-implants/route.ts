import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCharacterCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-clones.read_implants.v1'

// Manual trigger for the Vercel Workflows pilot — deliberately NOT in
// vercel.json's crons (character-status already covers implants on the
// schedule). Curl it with `Authorization: Bearer $CRON_SECRET` to exercise the
// full production chain: send() → queue topic "jobs" → consumer →
// start(characterImplantsWorkflow) → step → ESI → character_implant. Add a
// crons entry later to schedule it, or delete this route once the pilot is
// proven out.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCharacterCronJob('character-implants', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
