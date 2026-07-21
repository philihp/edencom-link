// corp-wallet-journal as a Vercel Workflow — phase 1 of the cron → Workflows
// migration (docs/cron-to-workflows/01-direct-jobs.md). Whole-corp batch work
// (paged append to corp_wallet_journal, keyed on entry id, plus name
// resolution), so it stays a single step: runJobWithHeartbeat wraps
// runCorpWalletJournal in the same start/end heartbeat pair the cron route
// recorded (source: 'vercel-workflow'). Append-only + keyed, so a step retry
// after a partial pull is naturally idempotent. runCorpWalletJournal uses
// forEachCorporation, whose per-corp heartbeat rows are preserved alongside the
// whole-job pair. The job module is untouched and still CLI-runnable.

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts).
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'corp-wallet-journal',
    async () => (await import('@/jobs/corpWalletJournal.js')).runCorpWalletJournal
  )
}

export async function corpWalletJournalWorkflow() {
  'use workflow'
  await runStep()
}
