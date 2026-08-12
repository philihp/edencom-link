// industry-systems as a Vercel Workflow — the first job migrated off the
// inline-run cron path (runDirectCronJob) in the cron → Workflows migration
// (docs/cron-to-workflows/01-direct-jobs.md). Whole-universe work (public ESI
// industry cost indices, no per-character tokens), so it stays a single step:
// runJobWithHeartbeat wraps runIndustrySystems in the same start/end heartbeat
// pair the cron route recorded, now with its own duration budget and
// Workflows' bounded retries, visible under Observability → Workflows. The job
// module (src/jobs/industrySystems.js) is untouched and still CLI-runnable.

// The Chancellor-only refresh row on /jobs (refreshCell →
// dispatchSingleJob) also start()s this workflow, with an OnDemandTarget whose
// taskId names the refresh_task row the step tracks running → done/error via
// withRefreshTask.
//
// The value imports live inside the step body on purpose: the workflow
// compiler bans Node modules in workflow context and traces every import
// reachable from it, but treats imports written inside a `'use step'` function
// as running in Node. ./lib (node:crypto) and the job module (src/jobs/lib.js
// → node:crypto, node:url) must therefore be imported here, not at the top
// level (the type import below is erased at compile time). See
// src/workflows/lib.ts.

import type { OnDemandTarget } from './lib'

async function runStep(taskId?: string) {
  'use step'
  const { runJobWithHeartbeat, withRefreshTask } = await import('./lib')
  await withRefreshTask(taskId, () =>
    runJobWithHeartbeat('industry-systems', async () => (await import('@/jobs/industrySystems.js')).runIndustrySystems)
  )
}

export async function industrySystemsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  await runStep(target?.taskId)
}
