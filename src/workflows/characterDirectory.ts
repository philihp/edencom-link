// character-directory as a Vercel Workflow — phase 2 of the cron → Workflows
// migration (docs/cron-to-workflows/02-account-jobs.md; this job subsumed the
// old character-affiliations the doc names). Account-wide batch work (no
// character scope): upserts character_directory / corporation / alliance /
// character_affiliation and refreshes registration.corporation_id (corp-table
// RLS keys off that). It stays a single step: runJobWithHeartbeat wraps
// runCharacterDirectory in a start/end heartbeat pair (source:
// 'vercel-workflow') — the same pair the queue consumer recorded for the
// account-wide jobs (source: 'vercel'), now moved into the step.
//
// Only the *scheduled* trigger moves here; the on-demand "Refresh ESI" path
// (dispatchRefresh's ACCOUNT_JOBS) still enqueues this job through the queue.
// The job module is untouched and still CLI-runnable.

import { type OnDemand, markRefreshTask } from './lib'

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts). markRefreshTask
// above is different: it IS a 'use step' export, made to be imported at top
// level and called from workflow context.
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'character-directory',
    async () => (await import('@/jobs/characterDirectory.js')).runCharacterDirectory
  )
}

export async function characterDirectoryWorkflow(onDemand?: OnDemand) {
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
