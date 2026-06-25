import { QueueClient } from '@vercel/queue'

// Vercel Queues are region-scoped: a message published to a topic in one region is
// only delivered to a consumer watching that same region's topic. The push consumer
// (wired up in vercel.json via experimentalTriggers) runs in the deployment's
// region, so the producer must publish to that same region.
//
// Left to the default, @vercel/queue keys the region off VERCEL_REGION and silently
// falls back to "iad1" when it isn't set — so a `send` from a runtime without
// VERCEL_REGION lands in the iad1 topic while the consumer watches the deployment's
// region (sfo1), and the message is never consumed. That was the bug behind refreshes
// looking "stuck in the queue": rows were enqueued but nothing ever picked them up.
//
// Pin the region explicitly so producer and consumer always agree. Defaults to the
// project's deployment region (sfo1); override with QUEUE_REGION if the project moves.
const region = process.env.QUEUE_REGION ?? 'sfo1'

export const queue = new QueueClient({ region })
export const { send, handleCallback } = queue
