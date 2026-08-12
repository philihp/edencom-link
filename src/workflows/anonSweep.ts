// anon-sweep as a Vercel Workflow. Account-wide housekeeping with no character
// scope — it deletes the anonymous accounts that never became anything — so it
// takes the single-step shape: runJobWithHeartbeat wraps runAnonSweep in the
// start/end heartbeat pair (source: 'vercel-workflow'), gaining a per-step
// duration budget and Workflows' bounded retries. Never dispatched on demand,
// so it takes no OnDemandTarget.
//
// The value imports live inside the step body on purpose: the workflow compiler
// bans Node modules in workflow context, and the job module reaches
// src/jobs/lib.js → node:crypto, node:url. See src/workflows/lib.ts.

async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat('anon-sweep', async () => (await import('@/jobs/anonSweep.js')).runAnonSweep)
}

export async function anonSweepWorkflow() {
  'use workflow'
  await runStep()
}
