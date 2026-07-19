import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret, runDirectCronJob } from '@/utils/cron'

// Daily esf_data refresh — scheduled in vercel.json at 12:51 UTC, 30 min after
// the sde-mirror cron (21 12), so it runs every day regardless of whether the
// SDE build changed. Decoupled from the sde-mirror workflow on purpose: the
// workflow also encodes ESF on every pass, but this standalone cron guarantees
// a daily attempt even if the workflow skips/fails before its encode step.
// Idempotent and a cheap no-op when esf_data is already at the current build
// (so a daily run costs one query unless the data is actually stale), which
// also avoids needlessly bumping Last-Modified / busting caches. Pass
// `?force=1` to re-encode regardless. Also the manual bootstrap: curl with
// `Authorization: Bearer $CRON_SECRET` (equivalent to `pnpm run esf-data`).
// maxDuration covers the ~35s mirror read + the ~10 MB typeDogma upsert with
// headroom (fluid compute allows well past 60s).
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const force = new URL(request.url).searchParams.get('force') != null
  const { runEsfData } = await import('@/jobs/esfData.js')
  let result: { files: number; build: number; skipped?: boolean } | undefined
  await runDirectCronJob('esf-data', async () => {
    result = await runEsfData({ force })
  })

  return NextResponse.json({ ok: true, ...result })
}
