// structure-directory as a Vercel Workflow. Whole-universe batch work (two
// public feeds, no tokens, no per-character fan-out), so it's the single-step
// shape: runJobWithHeartbeat wraps runStructureDirectory in the start/end
// heartbeat pair, gaining the per-step duration budget and bounded retries.
//
// The import lives inside the step body on purpose (the workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts).
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'structure-directory',
    async () => (await import('@/jobs/structureDirectory.js')).runStructureDirectory
  )
}

export async function structureDirectoryWorkflow() {
  'use workflow'
  await runStep()
}
