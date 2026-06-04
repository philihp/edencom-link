import { send } from '@vercel/queue'
import { NextRequest, NextResponse } from 'next/server'

import { authorizeCron } from '../_auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Daily is batch work (not a per-character loop), so it enqueues a single message
// the consumer runs whole-job. Heartbeat for daily is recorded by the consumer.
export const GET = async (request: NextRequest) => {
  if (!authorizeCron(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  await send('jobs', { job: 'daily' })

  return NextResponse.json({ ok: true, job: 'daily', enqueued: 1 })
}
