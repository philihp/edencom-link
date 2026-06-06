import { randomInt } from 'node:crypto'

import { handleCallback } from '@vercel/queue'

export const runtime = 'nodejs'
// 60s is the max the current Vercel plan allows. Per-character fan-out keeps each
// invocation small enough to fit; the daily whole-job message is a single batch and
// GitHub Actions remains the safety net if it ever exceeds this on large datasets.
export const maxDuration = 60

type Msg = { job: 'hourly' | 'assets' | 'structures' | 'daily' | 'orders'; characterId?: number }

// A thrown error fails the callback, so the Vercel queue retries the message
// (per retryAfterSeconds in vercel.json).
export const POST = handleCallback(async (message: Msg) => {
  const { job, characterId } = message
  const ids = characterId != null ? { characterIds: [characterId] } : undefined

  // Imported lazily so loading the route (and `next build`) never runs the job
  // modules' top-level supabase service-client setup, which needs env vars absent
  // at build time.
  switch (job) {
    case 'hourly': {
      const { runHourly } = await import('@/jobs/hourly.js')
      await runHourly(ids)
      return
    }
    case 'assets': {
      const { runAssets } = await import('@/jobs/assets.js')
      await runAssets(ids)
      return
    }
    case 'structures': {
      const { runStructures } = await import('@/jobs/structures.js')
      await runStructures(ids)
      return
    }
    case 'orders': {
      const { runOrders } = await import('@/jobs/orders.js')
      await runOrders(ids)
      return
    }
    case 'daily': {
      // Daily is a single whole-job message, so the consumer records its heartbeat
      // (the per-character producers record their own at enqueue time).
      const { runDaily } = await import('@/jobs/daily.js')
      const { recordHeartbeat } = await import('@/supabase.js')
      const runId = randomInt(1, 2 ** 48)
      await recordHeartbeat('daily', 'start', { runId, source: 'vercel' })
      try {
        await runDaily()
      } finally {
        await recordHeartbeat('daily', 'end', { runId, source: 'vercel' })
      }
      return
    }
    default:
      throw new Error(`unknown job: ${String(job)}`)
  }
})
