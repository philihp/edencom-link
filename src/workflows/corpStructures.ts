// corp-structures as a Vercel Workflow — phase 1 of the cron → Workflows
// migration (docs/cron-to-workflows/01-direct-jobs.md). Whole-corp batch work
// (not per-character), so it stays a single step: runJobWithHeartbeat wraps
// runCorpStructures in the same start/end heartbeat pair the cron route
// recorded (source: 'vercel-workflow'). runCorpStructures uses
// forEachCorporation, which additionally records its own per-corp heartbeat
// rows — that whole-job + per-corp pairing is unchanged from the runDirectCronJob
// path and is intentionally preserved (/character/refresh keys off it). The job
// module is untouched and still CLI-runnable.

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts).
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'corp-structures',
    async () => (await import('@/jobs/corpStructures.js')).runCorpStructures
  )
}

export async function corpStructuresWorkflow() {
  'use workflow'
  await runStep()
}
