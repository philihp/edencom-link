// industry-systems as a Vercel Workflow — the first job migrated off the
// inline-run cron path (runDirectCronJob) in the cron → Workflows migration
// (docs/cron-to-workflows/01-direct-jobs.md). Whole-universe work (public ESI
// industry cost indices, no per-character tokens), so it stays a single step:
// runJobWithHeartbeat wraps runIndustrySystems in the same start/end heartbeat
// pair the cron route recorded, now with its own duration budget and
// Workflows' bounded retries, visible under Observability → Workflows. The job
// module (src/jobs/industrySystems.js) is untouched and still CLI-runnable.

import { type OnDemand, markRefreshTask } from './lib'

// Both imports live inside the step body on purpose: the workflow compiler
// bans Node modules in workflow context and traces every import reachable from
// it, but treats imports written inside a `'use step'` function as running in
// Node. ./lib (node:crypto) and the job module (src/jobs/lib.js → node:crypto,
// node:url) must therefore be imported here, not at the top level. See
// src/workflows/lib.ts. markRefreshTask above is different: it IS a 'use step'
// export, made to be imported at top level and called from workflow context.
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'industry-systems',
    async () => (await import('@/jobs/industrySystems.js')).runIndustrySystems
  )
}

export async function industrySystemsWorkflow(onDemand?: OnDemand) {
  'use workflow'
  if (onDemand?.taskId) await markRefreshTask(onDemand.taskId, 'running')
  try {
    await runStep()
  } catch (err) {
    if (onDemand?.taskId)
      await markRefreshTask(onDemand.taskId, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
  if (onDemand?.taskId) await markRefreshTask(onDemand.taskId, 'done')
}
