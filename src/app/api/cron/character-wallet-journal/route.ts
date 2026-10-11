import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-wallet-journal: start()s the like-named
// Vercel Workflow (src/workflows/characterWalletJournal.ts), which enumerates the
// scoped characters itself and runs one step per character across a few lanes.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterWalletJournalWorkflow } = await import('@/workflows/characterWalletJournal')
  const run = await start(characterWalletJournalWorkflow, [])
  console.log(`[cron/character-wallet-journal] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
