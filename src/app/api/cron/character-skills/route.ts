import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCharacterCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-skills.read_skills.v1'

// Manual trigger for the character-skills Vercel Workflow — deliberately NOT in
// vercel.json's crons (character-status already covers skills on the schedule).
// Curl it with `Authorization: Bearer $CRON_SECRET` to exercise the full
// production chain: send() → queue topic "jobs" → consumer →
// start(characterSkillsWorkflow) → step → ESI → character_skill. Mirrors the
// character-implants pilot route.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCharacterCronJob('character-skills', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
