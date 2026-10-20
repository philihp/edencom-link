import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-mail. start()s the character-mail
// Vercel Workflow (src/workflows/characterMail.ts), which enumerates the
// scoped characters itself and runs one step per character across a few lanes —
// the shape every per-character extract uses on the scheduled path. The
// on-demand "Refresh ESI" flow enqueues this job via the queue instead.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterMailWorkflow } = await import('@/workflows/characterMail')
  const run = await start(characterMailWorkflow, [])
  console.log(`[cron/character-mail] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
