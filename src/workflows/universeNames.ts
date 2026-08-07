// universe-names as a Vercel Workflow — phase 2 of the cron → Workflows
// migration (docs/cron-to-workflows/02-account-jobs.md). Account-wide batch
// work (no character scope): resolves ESI id→name rows into universe_name plus
// the resolve* sweeps, all upserts. It stays a single step:
// runJobWithHeartbeat wraps runUniverseNames in a start/end heartbeat pair
// (source: 'vercel-workflow') — the same pair the queue consumer recorded for
// the account-wide jobs (source: 'vercel'), now moved into the step.
//
// Only the *scheduled* trigger moves here; the on-demand "Refresh ESI" path
// (dispatchRefresh's ACCOUNT_JOBS) still enqueues this job through the queue,
// where the consumer records its own whole-job heartbeat. The source column
// ('vercel' vs 'vercel-workflow') tells the two paths apart. The job module is
// untouched and still CLI-runnable.

import { type OnDemand, markRefreshTask } from './lib'

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts). markRefreshTask
// above is different: it IS a 'use step' export, made to be imported at top
// level and called from workflow context.
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat('universe-names', async () => (await import('@/jobs/universeNames.js')).runUniverseNames)
}

export async function universeNamesWorkflow(onDemand?: OnDemand) {
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
