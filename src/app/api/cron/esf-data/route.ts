import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret, runDirectCronJob } from '@/utils/cron'

// Manual bootstrap trigger for the esf_data table — deliberately NOT in
// vercel.json's crons. The nightly sde-mirror workflow only reaches its
// encodeEsf step after a full ingest, and it skips ingesting when CCP's
// current SDE build is already mirrored — so on a freshly-migrated esf_data
// table nothing would populate it until CCP ships a new build. Curl this with
// `Authorization: Bearer $CRON_SECRET` right after the migration applies to
// encode the six .pb2 rows from the current mirror (equivalent to
// `pnpm run esf-data`). Harmless to re-run: the upsert is idempotent.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { runEsfData } = await import('@/jobs/esfData.js')
  let result: { files: number; build: number } | undefined
  await runDirectCronJob('esf-data', async () => {
    result = await runEsfData()
  })

  return NextResponse.json({ ok: true, ...result })
}
