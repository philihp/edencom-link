// character-wallet-transactions as a Vercel Workflow — the first per-character
// fan-out job of phase 3 (docs/cron-to-workflows/03-per-character.md). It
// establishes the fan-out shape the other six per-character jobs follow.
//
// Formerly the cron route fanned out one Vercel queue message per scoped
// character (fanOutPerCharacterCronJob); it now start()s this workflow, which
// enumerates the characters itself (enumerateCharacters step) and runs one step
// per character, spread across a few statically assigned lanes. Everything
// per-character — token refresh, the per-character heartbeat pair, the ETag
// conditional request, the append-only upsert — stays inside the untouched job
// module (runCharacterWalletTransactions → forEachCharacter in src/jobs/lib.js).
//
// Only the *scheduled* trigger moves here. The on-demand "Refresh ESI" path
// (dispatchRefresh's PER_CHARACTER_JOBS) still enqueues this job through the
// queue; the job module is CLI-runnable too. One job, three triggers, one
// run*().

import { enumerateCharacters } from './lib'

// This job's ESI scope, and the lane count. Four lanes keeps a big account
// polite to ESI's error-rate limits (the queue already ran per-character pulls
// concurrently, so this is nothing new); it's a per-file constant, tune per job
// if heartbeat durations say so.
const SCOPES = ['esi-wallet.read_character_wallet.v1']
const LANES = 4

// Step: run the job for one character. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCharacter still refreshes the token and records the
// per-character heartbeat pair, unchanged. characterId is a bigint-derived
// number — the only thing crossing the step boundary, and serializable.
async function syncCharacter(characterId: number) {
  'use step'
  const { runCharacterWalletTransactions } = await import('@/jobs/characterWalletTransactions.js')
  await runCharacterWalletTransactions({ characterIds: [characterId] })
}

export async function characterWalletTransactionsWorkflow() {
  'use workflow'
  // Plain, deterministic control flow only — the documented exception to the
  // ramda rule (see sdeMirror.ts): the workflow body is compiled by the
  // 'use workflow' directive, so it stays simple loops over step calls with no
  // helpers imported at this (non-step) level.
  const ids = await enumerateCharacters(SCOPES)

  // Static round-robin lane assignment (the sde-mirror pattern): the
  // id→step-call mapping is identical on every replay regardless of how the
  // runtime resolves in-flight steps. Within a lane, characters run
  // sequentially; lanes run concurrently.
  const lanes: number[][] = Array.from({ length: LANES }, () => [])
  ids.forEach((id, i) => lanes[i % LANES].push(id))

  // A step that exhausts its bounded retries (e.g. a character whose token is
  // dead) should be *visible*, not silently re-looped the way the queue did —
  // but it must not abort the other lanes' characters. So each character's
  // failure is caught and the lane keeps going; a summary is rethrown at the
  // end so the run is marked failed in Observability with every failing
  // character listed. All characters are attempted regardless of how the
  // runtime treats a rejection inside Promise.all.
  const failures: number[] = []
  await Promise.all(
    lanes.map(async (lane) => {
      for (const id of lane) {
        try {
          await syncCharacter(id)
        } catch (err) {
          console.error(`[character-wallet-transactions] character ${id} failed:`, err)
          failures.push(id)
        }
      }
    }),
  )
  if (failures.length > 0) {
    failures.sort((a, b) => a - b)
    throw new Error(`character-wallet-transactions: ${failures.length} character step(s) failed: ${failures.join(', ')}`)
  }
}
