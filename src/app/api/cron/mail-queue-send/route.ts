import { NextRequest, NextResponse } from 'next/server'

import { createServiceClient } from '@/utils/supabase/service'
import { requireCronSecret } from '@/utils/cron'

// Vercel Cron trigger for mail-queue-send (every 10 minutes): sends every
// queued EVE mail by start()ing the workflow (src/workflows/mailQueueSend.ts).
// MCP send_mail tells the user a mail is sent when it queues it, so this is
// what keeps that promise. With nothing queued it returns before starting
// anything: one count over a small table, no workflow run, on almost every tick.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { count, error } = await createServiceClient()
    .from('mail_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'queued')
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ ok: true, skipped: 'nothing queued' })

  const { start } = await import('workflow/api')
  const { mailQueueSendWorkflow } = await import('@/workflows/mailQueueSend')
  const run = await start(mailQueueSendWorkflow, [])
  console.log(`[cron/mail-queue-send] started workflow run=${run.runId} for ${count} queued`)

  return NextResponse.json({ ok: true, runId: run.runId, queued: count })
}
