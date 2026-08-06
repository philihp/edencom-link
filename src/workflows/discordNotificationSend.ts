// discord-notification-send as a Vercel Workflow — the sender sweep for the
// notification outbox (docs/discord-bot/05-notification-sender.md). Single
// step: runJobWithHeartbeat wraps runDiscordNotificationSend in the start/end
// heartbeat pair (source: 'vercel-workflow'), same shape as the phase-1 direct
// jobs. The stage doc predates the completed cron → Workflows migration and
// suggested runDirectCronJob; that helper now survives only for the unscheduled
// esf-data/sheet-csv bootstrap routes, so a scheduled job uses this shape
// instead — one execution engine for everything on a cron.
//
// Safe to retry: the sweep is idempotent per row (a sent row is stamped
// sent_at and never re-selected), so a step retry after a partial failure just
// picks up whatever is still pending.

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts).
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat(
    'discord-notification-send',
    async () => (await import('@/jobs/discordNotificationSend.js')).runDiscordNotificationSend
  )
}

export async function discordNotificationSendWorkflow() {
  'use workflow'
  await runStep()
}
