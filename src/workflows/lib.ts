// Shared helper for the extract-job workflows (the cron → Vercel Workflows
// migration; see docs/cron-to-workflows/). The two pilot workflows
// (characterImplants.ts, sdeMirror.ts) inline everything; this lets the many
// like-shaped jobs share the heartbeat boilerplate as they migrate.
//
// This module exports two *kinds* of thing, imported differently:
//
//   1. Plain helpers (runJobWithHeartbeat) — NOT `'use step'`. They touch
//      Node-only modules (node:crypto) and pull in the job module (which imports
//      src/jobs/lib.js → node:crypto, node:url), and the workflow compiler bans
//      Node modules in workflow context. So they must only ever be imported
//      *dynamically, from inside a `'use step'` function body*, never at a
//      workflow file's top level. Each single-step workflow keeps a tiny inlined
//      step that does `const { runJobWithHeartbeat } = await import('./lib')`
//      before calling this — it runs inline within the caller's step invocation.
//
//   2. `'use step'` exports (enumerateCharacters) — these ARE steps, so the
//      compiler runs their bodies in Node context wherever they're called from.
//      They're meant to be imported at a workflow file's *top level* and called
//      from `'use workflow'` context, exactly like the steps in
//      sdeIngestSteps.ts. Their bodies keep their own Node imports dynamic for
//      the same env-vars-at-build-time reason.

// Run a whole extract job with the same start/end heartbeat pair
// runDirectCronJob (src/utils/cron.ts) records for the inline cron routes — but
// source: 'vercel-workflow'. Safe to retry: every job that uses this is
// idempotent (upserts / keyed appends / SCD-2 reconcile that converges), so a
// retry after a mid-step failure just re-runs and converges.
export async function runJobWithHeartbeat(job: string, load: () => Promise<() => Promise<unknown>>) {
  const { randomInt } = await import('node:crypto')
  const { recordHeartbeat } = await import('@/supabase.js')
  const { recordPeakRss } = await import('@/observability.js')
  const run = await load()
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat(job, 'start', { runId, source: 'vercel-workflow' })
  try {
    await run()
  } finally {
    recordPeakRss({ job })
    await recordHeartbeat(job, 'end', { runId, source: 'vercel-workflow' })
  }
}

// Step: enumerate the character_ids carrying the job's ESI scope(s), the same
// set fanOutPerCharacter*CronJob (src/utils/cron.ts) enumerates before sending
// one queue message each. Returning it from a step lets the per-character
// fan-out workflows (phase 3) map it into one step per character. Passing
// several scopes unions them (array overlap), exactly like the any-scope cron
// variant character-status uses. character_id is a bigint, so it comes back as a
// JS number — safe to serialize as a step result.
export async function enumerateCharacters(scopes: string[]): Promise<number[]> {
  'use step'
  const { selectCharacterIdsWithScopes } = await import('@/supabase.js')
  return (await selectCharacterIdsWithScopes(scopes)) as number[]
}

// Step: build the exact per-corp fan-out set fanOutPerCorporationCronJob
// (src/utils/cron.ts) sends today — one group per corporation plus a singleton
// group per character whose corporation isn't resolved yet — so the
// per-corporation fan-out workflows (phase 4) can run one step per group. Each
// group is the ordered character-id list forEachCorporation (src/jobs/lib.js)
// dedupes to a single handler call and falls back through on an in-game-role
// failure (a token can carry the OAuth scope without the director/accountant
// role the endpoint separately requires). Keeping every corp's characters in one
// group is the whole point: two concurrent reconciles of the same corp once
// corrupted the SCD-2 data, so a corp is never split across steps. The ids are
// registration uuids (token.character_id → registration.id), i.e. JS strings —
// safe to serialize as a step result.
export async function enumerateCorporations(scope: string): Promise<string[][]> {
  'use step'
  const { groupCharacterIdsByCorporation } = await import('@/supabase.js')
  const { byCorp, unresolved } = await groupCharacterIdsByCorporation([scope])
  return [...byCorp.values(), ...unresolved.map((id: string) => [id])]
}
