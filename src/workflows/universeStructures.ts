// universe-structures as a Vercel Workflow — phase 1 of the cron → Workflows
// migration (docs/cron-to-workflows/01-direct-jobs.md). Account-wide by
// construction (tries every candidate structure against every scoped token),
// so it stays a single step: runJobWithHeartbeat wraps runUniverseStructures
// in the same start/end heartbeat pair the cron route recorded, now
// source: 'vercel-workflow', with its own duration budget and Workflows'
// bounded retries. The job module is untouched and still CLI-runnable.

// Both imports live inside the step body on purpose: the workflow compiler
// bans Node modules in workflow context and traces every import reachable from
// it, but treats imports written inside a `'use step'` function as running in
// Node. See src/workflows/lib.ts.
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'universe-structures',
    async () => (await import('@/jobs/universeStructures.js')).runUniverseStructures
  )
}

export async function universeStructuresWorkflow() {
  'use workflow'
  await runStep()
}
