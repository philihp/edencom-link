// Queue consumer for the innomin.at appraisal throttle (topic "innominate", wired
// up in vercel.json via experimentalTriggers). Every appraisal request is
// enqueued here so the whole deployment stays inside the authorized budget
// (150/minute; we drain at 120/minute as buffer) — see the throttle
// explanation in src/innominate.ts. This route is the ONLY thing that drains the topic; the
// producer (appraise()) enqueues and blocks polling the shared DB row this
// consumer fills in.
import { handleCallback } from '@/utils/queue'
import { InnominateThrottleRetry, runInnominateQueueMessage, type InnominateQueueMessage } from '@/innominate'

export const runtime = 'nodejs'

// When it isn't this message's turn under the global throttle, runInnominateQueueMessage
// throws InnominateThrottleRetry(afterSeconds); the retry handler reschedules the
// message for that many seconds later instead of failing it. Any other throw
// falls through to the queue's default retry (retryAfterSeconds in vercel.json).
export const POST = handleCallback(
  async (message: InnominateQueueMessage) => {
    await runInnominateQueueMessage(message)
  },
  {
    retry: (error) => (error instanceof InnominateThrottleRetry ? { afterSeconds: error.afterSeconds } : undefined),
  }
)
