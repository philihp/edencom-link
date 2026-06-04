import { randomInt } from 'node:crypto'

import { send } from '@vercel/queue'
import { NextRequest, NextResponse } from 'next/server'

import { authorizeJobTrigger } from '../_auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SCOPES = ['esi-corporations.read_structures.v1']

export const GET = async (request: NextRequest) => {
  if (!authorizeJobTrigger(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Imported lazily so loading the route (and `next build`) never runs supabase.js's
  // top-level service-client setup, which needs env vars absent at build time.
  const { recordHeartbeat, selectCharacterIdsWithScopes } = await import('@/supabase.js')

  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('structures', 'start', { runId, source: 'vercel' })
  const characterIds = await selectCharacterIdsWithScopes(SCOPES)
  await Promise.all(characterIds.map((characterId) => send('jobs', { job: 'structures', characterId })))
  await recordHeartbeat('structures', 'end', { runId, source: 'vercel' })

  return NextResponse.json({ ok: true, job: 'structures', enqueued: characterIds.length })
}
