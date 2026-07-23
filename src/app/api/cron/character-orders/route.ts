import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-orders. Formerly fanned out one queue
// message per scoped character (fanOutPerCharacterCronJob); it now start()s the
// character-orders Vercel Workflow (src/workflows/characterOrders.ts), which
// enumerates the scoped characters itself and runs one step per character across
// a few lanes. Only the scheduled path moves — the on-demand "Refresh ESI" flow
// still enqueues this job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterOrdersWorkflow } = await import('@/workflows/characterOrders')
  const run = await start(characterOrdersWorkflow, [])
  console.log(`[cron/character-orders] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
