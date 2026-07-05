import { randomInt } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'
import { forEach } from 'ramda'

// Shared plumbing for the /api/cron/* routes that replaced the old per-job
// GitHub Actions schedules. Vercel signs cron requests with a
// `Authorization: Bearer $CRON_SECRET` header (see vercel.json's `crons`
// entries), so every route checks that instead of trusting the request.
export const requireCronSecret = (request: NextRequest): NextResponse | null => {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

// For the handful of extract jobs that are whole-corp/whole-universe batches
// rather than per-character work (corp-structures, corp-blueprints,
// corp-wallet-journal, universe-structures, industry-systems): run the job
// inline in the cron function and wrap it in a start/end heartbeat, the same
// shape the job's own GitHub Actions workflow used to record via
// `pnpm run heartbeat <job> start/end`.
export const runDirectCronJob = async (job: string, run: () => Promise<unknown>) => {
  const { recordHeartbeat } = await import('@/supabase.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat(job, 'start', { runId, source: 'vercel-cron' })
  try {
    await run()
  } finally {
    await recordHeartbeat(job, 'end', { runId, source: 'vercel-cron' })
  }
}

// For the per-character extract jobs: enumerate every character carrying the
// job's ESI scope and fan out one Vercel queue message each, mirroring the
// on-demand "Refresh ESI" flow (dispatchRefresh.ts). Each queued invocation
// stays small enough to fit the function duration limit regardless of how
// many characters are registered, and records its own per-character
// heartbeat (see forEachCharacter/forEachCorporation in src/jobs/lib.js).
export const fanOutPerCharacterCronJob = async (job: string, scope: string) => {
  const { selectCharacterIdsWithScopes } = await import('@/supabase.js')
  const { send } = await import('@/utils/queue')
  const characterIds = await selectCharacterIdsWithScopes([scope])
  await Promise.all(characterIds.map((characterId) => send('jobs', { job, characterId })))
  return characterIds.length
}

// For the corp-scoped extract jobs (corp-assets, corp-industry-jobs,
// corp-wallet-transactions): fanning out per character, like
// fanOutPerCharacterCronJob, can enqueue two concurrent messages for the same
// corp when more than one of its characters carries the scope. Each message
// independently reconciles that corp's whole asset/job/transaction set, and
// the two invocations racing corrupts the data — one's INSERT collides with
// the other's already-committed row (`duplicate key value violates unique
// constraint ..._current_item_idx`), aborting the losing invocation partway
// through with some rows already closed (is_current: false) but never
// reopened, so real items vanish from the *_asset/*_blueprint views until a
// later, non-racing run reinserts them. Dedupe to one character — and so one
// queue message — per corporation to make that race impossible.
export const fanOutPerCorporationCronJob = async (job: string, scope: string) => {
  const { selectCharacterIdsWithScopes, sudoSupabase } = await import('@/supabase.js')
  const { send } = await import('@/utils/queue')
  const characterIds = await selectCharacterIdsWithScopes([scope])
  if (characterIds.length === 0) return 0

  const { data: registrations, error } = await sudoSupabase
    .from('registration')
    .select('id, corporation_id')
    .in('id', characterIds)
  if (error) throw error

  const seenCorps = new Set<number>()
  const picked: string[] = []
  forEach((r: { id: string; corporation_id: number | null }) => {
    if (r.corporation_id == null || seenCorps.has(r.corporation_id)) return
    seenCorps.add(r.corporation_id)
    picked.push(r.id)
  }, registrations ?? [])

  await Promise.all(picked.map((characterId) => send('jobs', { job, characterId })))
  return picked.length
}

// For the account-wide extract jobs that already process every registration
// in one batch (character-affiliations, universe-names): dispatch a single
// queue message: the consumer records its own whole-job heartbeat (see
// src/app/api/queue/jobs/route.ts).
export const dispatchAccountCronJob = async (job: string) => {
  const { send } = await import('@/utils/queue')
  await send('jobs', { job })
}
