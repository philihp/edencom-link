import { randomInt } from 'node:crypto'

import { send } from '@vercel/queue'
import { NextRequest, NextResponse } from 'next/server'

import { authorizeJobTrigger } from '../_auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SCOPES = ['esi-wallet.read_character_wallet.v1', 'esi-industry.read_character_jobs.v1']

export const GET = async (request: NextRequest) => {
  if (!authorizeJobTrigger(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Imported lazily so loading the route (and `next build`) never runs supabase.js's
  // top-level service-client setup, which needs env vars absent at build time.
  const { recordHeartbeat, selectCharacterIdsWithScopes } = await import('@/supabase.js')

  // One run id ties this trigger's start and end heartbeats to a single row. This
  // marks that the job was enqueued and how many units; per-character completion is
  // left to the queue consumer (and GitHub Actions records its own row).
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('hourly', 'start', { runId, source: 'vercel' })
  const characterIds = await selectCharacterIdsWithScopes(SCOPES)
  await Promise.all(characterIds.map((characterId) => send('jobs', { job: 'hourly', characterId })))
  await recordHeartbeat('hourly', 'end', { runId, source: 'vercel' })

  return NextResponse.json({ ok: true, job: 'hourly', enqueued: characterIds.length })
}
