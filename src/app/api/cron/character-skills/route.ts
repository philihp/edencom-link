import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Manual trigger for the character-skills per-character fan-out Vercel Workflow
// — deliberately NOT in vercel.json's crons (character-status already covers
// skills on the schedule). Curl it with `Authorization: Bearer $CRON_SECRET` to
// start a run: the workflow enumerates the scoped characters itself and runs one
// step per character across a few lanes (src/workflows/characterSkills.ts).
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterSkillsWorkflow } = await import('@/workflows/characterSkills')
  const run = await start(characterSkillsWorkflow, [])
  console.log(`[cron/character-skills] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
