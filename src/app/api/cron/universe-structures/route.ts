import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret, runDirectCronJob } from '@/utils/cron'

// Vercel Cron replacement for the old `universe-structures.yml` GitHub Action.
// Account-wide by construction (tries every candidate against every scoped token),
// so it runs inline rather than fanning out via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  await runDirectCronJob('universe-structures', async () => {
    const { runUniverseStructures } = await import('@/jobs/universeStructures.js')
    await runUniverseStructures()
  })

  return NextResponse.json({ ok: true })
}
