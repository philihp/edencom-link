import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-fittings. start()s the character-fittings
// Vercel Workflow (src/workflows/characterFittings.ts), which enumerates the
// scoped characters itself and runs one step per character across a few lanes —
// the shape every per-character extract uses on the scheduled path. The
// on-demand "Refresh ESI" flow enqueues this job via the queue instead.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterFittingsWorkflow } = await import('@/workflows/characterFittings')
  const run = await start(characterFittingsWorkflow, [])
  console.log(`[cron/character-fittings] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
