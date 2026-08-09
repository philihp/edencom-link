import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for corp-contracts: start()s the corp-contracts Vercel
// Workflow (src/workflows/corpContracts.ts), which groups the scoped characters
// by corporation itself and runs one step per corp. The on-demand "Refresh ESI"
// flow starts the same workflow with a target.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { corpContractsWorkflow } = await import('@/workflows/corpContracts')
  const run = await start(corpContractsWorkflow, [])
  console.log(`[cron/corp-contracts] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
