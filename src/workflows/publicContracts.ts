// public-contracts as a Vercel Workflow. Whole-universe public data (no tokens,
// no per-character fan-out), so the single-step shape: runJobWithHeartbeat
// wraps runPublicContracts in the start/end heartbeat pair, gaining the
// per-step duration budget and bounded retries. A retry re-sweeps only the
// regions still due, since a swept region is not due until ESI's cache of it
// expires (src/jobs/publicContractFields.js, regionDue).
//
// The value imports live inside the step body on purpose (see
// src/workflows/lib.ts): the workflow compiler bans Node modules in workflow
// context but treats imports inside a 'use step' function as running in Node.

import type { OnDemandTarget } from './lib'

async function runStep(taskId?: string) {
  'use step'
  const { runJobWithHeartbeat, withRefreshTask } = await import('./lib')
  await withRefreshTask(taskId, () =>
    runJobWithHeartbeat('public-contracts', async () => (await import('@/jobs/publicContracts.js')).runPublicContracts)
  )
}

export async function publicContractsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  await runStep(target?.taskId)
}
