import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-contracts: start()s the character-contracts
// Vercel Workflow (src/workflows/characterContracts.ts), which enumerates the
// scoped characters itself and runs one step per character across a few lanes.
// The on-demand "Refresh ESI" flow starts the same workflow with a target.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterContractsWorkflow } = await import('@/workflows/characterContracts')
  const run = await start(characterContractsWorkflow, [])
  console.log(`[cron/character-contracts] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
