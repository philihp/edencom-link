// corp-blueprints as a Vercel Workflow — the last direct-run job in phase 1 of
// the cron → Workflows migration (docs/cron-to-workflows/01-direct-jobs.md).
// The one SCD-2 reconciler in this phase (corp_blueprint_over_time): unchanged
// items get their valid_until bumped, changed items open a new version and
// close the old, vanished items are closed. It stays a single step:
// runJobWithHeartbeat wraps runCorpBlueprints in the same start/end heartbeat
// pair the cron route recorded (source: 'vercel-workflow'). The reconcile
// converges on re-run, so a step retry after a partial failure is safe.
// runCorpBlueprints uses forEachCorporation, whose per-corp heartbeat rows are
// preserved alongside the whole-job pair. The job module is untouched and still
// CLI-runnable.

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts).
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'corp-blueprints',
    async () => (await import('@/jobs/corpBlueprints.js')).runCorpBlueprints
  )
}

export async function corpBlueprintsWorkflow() {
  'use workflow'
  await runStep()
}
