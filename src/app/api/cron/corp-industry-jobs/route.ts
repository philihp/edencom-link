import { NextRequest, NextResponse } from 'next/server'

import { fanOutPerCorporationCronJob, requireCronSecret } from '@/utils/cron'

const SCOPE = 'esi-industry.read_corporation_jobs.v1'

// Vercel Cron replacement for the old `corp-industry-jobs.yml` GitHub Action. Fans out
// one Vercel queue message per corporation (deduped across its scoped characters — see
// fanOutPerCorporationCronJob) rather than one per character, so a corp with several
// scoped characters doesn't get pulled redundantly every run.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const dispatched = await fanOutPerCorporationCronJob('corp-industry-jobs', SCOPE)

  return NextResponse.json({ ok: true, dispatched })
}
