import { randomInt } from 'node:crypto'

import { send } from '@vercel/queue'
import { NextRequest, NextResponse } from 'next/server'

import { authorizeCron } from '../_auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SCOPES = ['esi-assets.read_assets.v1']

export const GET = async (request: NextRequest) => {
  if (!authorizeCron(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Imported lazily so loading the route (and `next build`) never runs supabase.js's
  // top-level service-client setup, which needs env vars absent at build time.
  const { recordHeartbeat, selectCharacterIdsWithScopes } = await import('@/supabase.js')

  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('assets', 'start', { runId, source: 'vercel' })
  const characterIds = await selectCharacterIdsWithScopes(SCOPES)
  await Promise.all(characterIds.map((characterId) => send('jobs', { job: 'assets', characterId })))
  await recordHeartbeat('assets', 'end', { runId, source: 'vercel' })

  return NextResponse.json({ ok: true, job: 'assets', enqueued: characterIds.length })
}
