import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret, runDirectCronJob } from '@/utils/cron'

// Vercel Cron replacement for the old `corp-structures.yml` GitHub Action. Whole-corp
// batch work (not per-character), so it runs inline rather than fanning out via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  await runDirectCronJob('corp-structures', async () => {
    const { runCorpStructures } = await import('@/jobs/corpStructures.js')
    await runCorpStructures()
  })

  return NextResponse.json({ ok: true })
}
