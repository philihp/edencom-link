import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret, runDirectCronJob } from '@/utils/cron'

// Manual bootstrap / on-demand trigger for the esf_data table — deliberately
// NOT in vercel.json's crons. The sde-mirror workflow now encodes ESF on every
// pass (including the build-unchanged skip path), so this is mainly for the
// first population right after the migration and for forcing a re-encode. Curl
// with `Authorization: Bearer $CRON_SECRET` to encode the six .pb2 rows from
// the current mirror (equivalent to `pnpm run esf-data`); idempotent, and a
// no-op when esf_data is already at the current build. Pass `?force=1` to
// re-encode regardless. maxDuration covers the ~35s mirror read + the ~10 MB
// typeDogma upsert with headroom (fluid compute allows well past 60s).
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
