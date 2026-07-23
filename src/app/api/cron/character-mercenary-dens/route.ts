import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-mercenary-dens. Formerly fanned out one queue
// message per scoped character (fanOutPerCharacterCronJob); it now start()s the
// character-mercenary-dens Vercel Workflow (src/workflows/characterMercenaryDens.ts),
// which enumerates the scoped characters itself and runs one step per character
// across a few lanes. Only the scheduled path moves — the on-demand "Refresh ESI"
// flow still enqueues this job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterMercenaryDensWorkflow } = await import('@/workflows/characterMercenaryDens')
  const run = await start(characterMercenaryDensWorkflow, [])
  console.log(`[cron/character-mercenary-dens] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
