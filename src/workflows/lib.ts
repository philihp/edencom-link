// Shared helpers for the extract-job workflows (the cron → Vercel Workflows
// migration; see docs/cron-to-workflows/, complete). The sde-mirror workflow
// (sdeMirror.ts) inlines everything; this lets the many like-shaped jobs share
// the heartbeat, enumeration, and refresh_task boilerplate.
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

// The on-demand "Refresh ESI" dispatch (src/app/character/dispatchRefresh.ts)
// start()s a job's workflow with one of these instead of letting it enumerate:
// registrationIds pins the run to one character (or, for a corp-scoped job, one
// corp's whole character group; absent for the account-wide jobs), and taskId
// names the refresh_task row the run reports its status to via withRefreshTask.
// Types are erased at compile time, so importing this at a workflow file's top
// level is fine.
export type OnDemandTarget = { registrationIds?: string[]; taskId?: string }

// Wrap a job run in refresh_task status tracking, preserving the retired queue
// consumer's exact best-effort semantics: flip the row to running before the
// job, done after, error on a throw — recorded and swallowed, never rethrown,
// so a tracked run isn't retried and the /jobs poller always
// settles on a terminal state the user can see. Without a taskId (the
// scheduled path) it just runs the job, letting a throw propagate into the
// step's bounded retries. Plain helper, NOT a step — import it dynamically
// inside a `'use step'` body, per the rules above.
export async function withRefreshTask(taskId: string | undefined, run: () => Promise<unknown>) {
  if (taskId == null) {
    await run()
    return
  }
  await markTaskRunning(taskId)
  try {
    await run()
    await markTaskSettled(taskId)
  } catch (e) {
    await markTaskSettled(taskId, e)
  }
}

// The two halves of withRefreshTask, usable on their own by a workflow whose
// run is a fan-out rather than a single call (market-prices): there is no one
// function to wrap, so the row is flipped to running alongside the heartbeat
// that opens the run and settled alongside the one that closes it. Same
// best-effort semantics — a tracked run always reaches a terminal state the
// /jobs poller can see. Plain helpers, NOT steps: import them dynamically
// inside a `'use step'` body, per the rules above.
export async function markTaskRunning(taskId: string) {
  const { sudoSupabase } = await import('@/supabase.js')
  await sudoSupabase
    .from('refresh_task')
    .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', taskId)
}

// Settle the row: done when `failure` is absent, error (carrying its message)
// otherwise.
export async function markTaskSettled(taskId: string, failure?: unknown) {
  const { sudoSupabase } = await import('@/supabase.js')
  await sudoSupabase
    .from('refresh_task')
    .update({
      status: failure === undefined ? 'done' : 'error',
      ended_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(failure === undefined
        ? {}
        : { error: String(failure instanceof Error ? failure.message : failure).slice(0, 500) }),
    })
    .eq('id', taskId)
}

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
    recordPeakRss({ job })
    await recordHeartbeat(job, 'end', { runId, source: 'vercel-workflow', ok: true })
  } catch (e) {
    // Stamp the failure on the end row (heartbeat.ok/error) and rethrow so the
    // step still fails visibly in Observability and gets its bounded retries.
    recordPeakRss({ job })
    await recordHeartbeat(job, 'end', {
      runId,
      source: 'vercel-workflow',
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

// Step: enumerate the registrations carrying the job's ESI scope(s). Returning
// the set from a step lets the per-character fan-out workflows (phase 3) map it
// into one step per character. Passing several scopes unions them (array
// overlap), exactly like the any-scope selection character-status needs. The
// ids are registration uuids (token.registration_id → registration.id), i.e.
// JS strings — safe to serialize as a step result.
export async function enumerateCharacters(scopes: string[]): Promise<string[]> {
  'use step'
  const { selectRegistrationIdsWithScopes } = await import('@/supabase.js')
  return (await selectRegistrationIdsWithScopes(scopes)) as string[]
}

// Step: build the per-corp fan-out set — one group per corporation plus a
// singleton group per character whose corporation isn't resolved yet — so the
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
