import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret, runDirectCronJob } from '@/utils/cron'

// Manual bootstrap / on-demand trigger for the sheet_csv table — deliberately
// NOT in vercel.json's crons. The sde-mirror workflow encodes these CSVs on
// every pass (its encodeSheets tail step), so this is mainly for the first
// population right after the migration and for forcing a re-encode after a
// transform change without waiting for tonight's mirror. Curl with
// `Authorization: Bearer $CRON_SECRET` to encode the CSV rows from the current
// mirror (equivalent to `pnpm run sheet-csv`); idempotent, and a no-op when
// sheet_csv is already at the current build. Pass `?force=1` to re-encode
// regardless.
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const force = new URL(request.url).searchParams.get('force') != null
  const { runSheetCsv } = await import('@/jobs/sheetCsv.js')
  let result: { files: number; build: number; skipped?: boolean } | undefined
  await runDirectCronJob('sheet-csv', async () => {
    result = await runSheetCsv({ force })
  })

  return NextResponse.json({ ok: true, ...result })
}
