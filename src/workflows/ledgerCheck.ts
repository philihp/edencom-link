// ledger-check as a Vercel Workflow (ledger stage 1, docs/ledger/stage-1.md):
// the same single-step shape as market-adjusted-prices. One step wraps the job
// in the heartbeat pair. The job reads the wallet journals in paced keyset
// pages, writes only the ledger tables, and stops at the row budget. The value
// imports stay inside the step body (see src/workflows/lib.ts).

async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat('ledger-check', async () => {
    const { runLedgerCheck } = await import('@/jobs/ledgerCheck')
    return () => runLedgerCheck()
  })
}

export async function ledgerCheckWorkflow() {
  'use workflow'
  await runStep()
}
