// mail-queue-send: every mail waiting in mail_send_log as 'queued', across
// every account, sent oldest first through sendQueuedMail. MCP send_mail
// writes those rows and tells the user the mail is sent; this sweep, every
// 10 minutes, is what makes that true. The claim (queued → pending) means two
// overlapping runs cannot send one row twice.
//
// The cron route (src/app/api/cron/mail-queue-send/route.ts) starts the
// workflow only when a row is queued. A send that fails closes its row
// 'error' (sendQueuedMail does that) and the sweep moves on; a row whose
// account cannot be read is never claimed, so it stays queued for the next
// run.
import { reduce } from 'ramda'

import { callerForUser, isFailure } from '@/app/api/fittings/lib'
import { sendQueuedMail } from '@/app/mail/lib'
import { createServiceClient } from '@/utils/supabase/service'

const TAG = 'mail-queue-send'

type QueuedRow = { id: number; user_id: string }

export const runMailQueueSend = async () => {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('mail_send_log')
    .select('id, user_id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .returns<QueuedRow[]>()
  if (error) throw new Error(`mail_send_log read failed: ${error.message}`)

  const sendOne = async ({ id, user_id }: QueuedRow) => {
    const caller = await callerForUser(user_id, supabase)
    const outcome = isFailure(caller) ? caller : await sendQueuedMail(caller, id)
    console.log(
      'error' in outcome
        ? `[${TAG}] #${id} not sent: ${outcome.status} ${outcome.error}`
        : `[${TAG}] #${id} sent as mail ${outcome.mailId}`
    )
  }

  // One at a time, in the order they were queued.
  await reduce<QueuedRow, Promise<void>>(
    (settled, row) => settled.then(() => sendOne(row)),
    Promise.resolve(),
    data ?? []
  )
}
