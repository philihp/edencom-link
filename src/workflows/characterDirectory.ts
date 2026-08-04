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
// Both triggers start() this workflow now (phase 5): the cron route starts it
// bare, and the on-demand "Refresh ESI" path (dispatchRefresh's ACCOUNT_JOBS)
// starts it with an OnDemandTarget whose taskId names the refresh_task row the
// step tracks running → done/error via withRefreshTask. The job module is
// untouched and still CLI-runnable.

import type { OnDemandTarget } from './lib'

// The value imports live inside the step body on purpose (workflow compiler
// bans Node modules in workflow context — see src/workflows/lib.ts; the type
// import above is erased at compile time).
async function runStep(taskId?: string) {
  'use step'
  const { runJobWithHeartbeat, withRefreshTask } = await import('./lib')
  await withRefreshTask(taskId, () =>
    runJobWithHeartbeat(
      'character-directory',
      async () => (await import('@/jobs/characterDirectory.js')).runCharacterDirectory
    )
  )
}

export async function characterDirectoryWorkflow(target?: OnDemandTarget) {
  'use workflow'
  await runStep(target?.taskId)
}
