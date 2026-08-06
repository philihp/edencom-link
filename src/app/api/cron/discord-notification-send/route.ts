import { NextRequest, NextResponse } from 'next/server'

import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for discord-notification-send (every 5 minutes): posts
// pending notification outbox rows to their linked Discord channels. Like every
// other scheduled job it just start()s the workflow
// (src/workflows/discordNotificationSend.ts) — the workflow owns retries, its
// run/step status shows under Observability → Workflows, and its step records
// the heartbeat pair (source: 'vercel-workflow').
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { discordNotificationSendWorkflow } = await import('@/workflows/discordNotificationSend')
  const run = await start(discordNotificationSendWorkflow, [])
  console.log(`[cron/discord-notification-send] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
