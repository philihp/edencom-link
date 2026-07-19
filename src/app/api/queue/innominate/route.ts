// Queue consumer for the innomin.at appraisal throttle (topic "innominate", wired
// up in vercel.json via experimentalTriggers). Every appraisal request is
// enqueued here so the whole deployment sends at most one request every 18
// seconds (the provider's 200/hour budget) — see the throttle explanation in
// src/innominate.ts. This route is the ONLY thing that drains the topic; the
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
