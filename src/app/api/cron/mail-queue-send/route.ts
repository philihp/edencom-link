import { NextRequest, NextResponse } from 'next/server'

import { autoSendEnabled } from '@/app/mail/autoSend'
import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for mail-queue-send (every 10 minutes): sends every
// queued EVE mail while the auto-send-eve-mail flag is on, by start()ing the
// workflow (src/workflows/mailQueueSend.ts). With the flag off it returns
// before starting anything, so an off flag costs no workflow run.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  if (!(await autoSendEnabled())) return NextResponse.json({ ok: true, skipped: 'auto-send-eve-mail is off' })

  const { start } = await import('workflow/api')
  const { mailQueueSendWorkflow } = await import('@/workflows/mailQueueSend')
  const run = await start(mailQueueSendWorkflow, [])
  console.log(`[cron/mail-queue-send] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
