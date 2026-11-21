import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for ledger-check (ledger stage 1): verify the secret,
// start() the workflow, return. Daily, at a minute no other cron uses.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { ledgerCheckWorkflow } = await import('@/workflows/ledgerCheck')
  const run = await start(ledgerCheckWorkflow, [])
  console.log(`[cron/ledger-check] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
