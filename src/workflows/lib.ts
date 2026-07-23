// Shared helper for the extract-job workflows (the cron → Vercel Workflows
// migration; see docs/cron-to-workflows/). The two pilot workflows
// (characterImplants.ts, sdeMirror.ts) inline everything; this lets the many
// like-shaped jobs share the heartbeat boilerplate as they migrate.
//
// IMPORTANT — this module must only ever be imported *dynamically, from inside
// a `'use step'` function body*, never at a workflow file's top level or from
// `'use workflow'` context. It touches Node-only modules (node:crypto) and
// pulls in the job module (which imports src/jobs/lib.js → node:crypto,
// node:url), and the workflow compiler bans Node modules in workflow context —
// it traces every import reachable from workflow context, but treats imports
// written inside a step body as running in Node. So each workflow file keeps a
// tiny inlined step that does `const { runJobWithHeartbeat } = await
// import('./lib')` before calling this. (This is why runJobWithHeartbeat is a
// plain function, not itself a `'use step'` — it runs inline within the
// caller's step invocation.)

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
