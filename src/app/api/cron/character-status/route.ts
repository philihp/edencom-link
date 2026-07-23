import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for the combined character-status extract. Formerly fanned
// out one queue message per character carrying any of the five scopes
// (fanOutPerCharacterAnyScopeCronJob); it now start()s the character-status
// Vercel Workflow (src/workflows/characterStatus.ts), which enumerates those
// characters itself (unioning the five scopes) and runs one step per character
// across a few lanes. Only the scheduled path moves — the on-demand "Refresh ESI"
// flow still enqueues this job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterStatusWorkflow } = await import('@/workflows/characterStatus')
  const run = await start(characterStatusWorkflow, [])
  console.log(`[cron/character-status] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
