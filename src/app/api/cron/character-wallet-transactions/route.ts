import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for character-wallet-transactions. Formerly fanned out one
// queue message per scoped character (fanOutPerCharacterCronJob); it now start()s
// the character-wallet-transactions Vercel Workflow
// (src/workflows/characterWalletTransactions.ts), which enumerates the scoped
// characters itself and runs one step per character across a few lanes. Only the
// scheduled path moves — the on-demand "Refresh ESI" flow still enqueues this
// job via the queue.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { characterWalletTransactionsWorkflow } = await import('@/workflows/characterWalletTransactions')
  const run = await start(characterWalletTransactionsWorkflow, [])
  console.log(`[cron/character-wallet-transactions] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
