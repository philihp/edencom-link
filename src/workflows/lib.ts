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

// The on-demand "Refresh ESI" handle (phase 5 of the cron → Workflows
// migration): dispatchRefresh/dispatchSingleJob start() each workflow with a
// pre-enumerated target — the exact ids the queue message used to carry — plus
// the refresh_task row the /character/refresh matrix tracks. A scheduled cron
// start() passes nothing, and the workflow enumerates for itself.
export type OnDemand = {
  // Per-character workflows: the registrations to sync (usually one). Per-corp
  // workflows: one corp's whole scoped-character group, kept together so a
  // corp's reconcile is never split across concurrent runs. Absent: enumerate.
  registrationIds?: string[]
  // A refresh_task row to flip running → done/error as the run progresses.
  taskId?: string
}

// Step: flip an on-demand run's refresh_task row, preserving the old queue
// consumer's exact best-effort semantics — a failure to record status is logged
// and swallowed (never throws), so a DB hiccup can't fail a run whose actual
// extract work succeeded, and the page's 10-minute task floor covers a lost
// terminal update.
export async function markRefreshTask(taskId: string, status: 'running' | 'done' | 'error', error?: string) {
  'use step'
  const { sudoSupabase } = await import('@/supabase.js')
  const now = new Date().toISOString()
  const { error: updateError } = await sudoSupabase
    .from('refresh_task')
    .update({
      status,
      updated_at: now,
      ...(status === 'running' ? { started_at: now } : { ended_at: now }),
      ...(error != null ? { error: error.slice(0, 500) } : {}),
    })
    .eq('id', taskId)
  if (updateError) console.error(`[refresh_task] failed to mark ${taskId} ${status}:`, updateError)
}

// Step: enumerate the registration ids carrying the job's ESI scope(s), the
// same set fanOutPerCharacter*CronJob (src/utils/cron.ts) enumerated before
// sending one queue message each. Returning it from a step lets the
// per-character fan-out workflows (phase 3) map it into one step per character.
// Passing several scopes unions them (array overlap), exactly like the
// any-scope cron variant character-status uses. The ids are registration uuids
// (token.registration_id), i.e. JS strings — safe to serialize as a step
// result.
export async function enumerateCharacters(scopes: string[]): Promise<string[]> {
  'use step'
  const { selectRegistrationIdsWithScopes } = await import('@/supabase.js')
  return (await selectRegistrationIdsWithScopes(scopes)) as string[]
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
// registration uuids (token.registration_id → registration.id), i.e. JS strings —
// safe to serialize as a step result.
export async function enumerateCorporations(scope: string): Promise<string[][]> {
  'use step'
  const { groupRegistrationIdsByCorporation } = await import('@/supabase.js')
  const { byCorp, unresolved } = await groupRegistrationIdsByCorporation([scope])
  return [...byCorp.values(), ...unresolved.map((id: string) => [id])]
}
