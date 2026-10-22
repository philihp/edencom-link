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
  // Two vercel.json entries share this route: `?owners=1` hourly walks only the
  // characters holding a den, the bare path every 6h walks everyone with the
  // scope (docs/workflow-events.md §2).
  const ownersOnly = request.nextUrl.searchParams.get('owners') === '1'
  const run = await start(characterMercenaryDensWorkflow, ownersOnly ? [{ denOwnersOnly: true }] : [])
  console.log(`[cron/character-mercenary-dens] started workflow run=${run.runId}${ownersOnly ? ' (den owners)' : ''}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
