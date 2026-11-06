// mail-queue-send as a Vercel Workflow — sends every queued EVE mail
// (src/app/mail/sendQueue.ts). Single step, the discord-notification-send
// shape: runJobWithHeartbeat wraps the sweep in the start/end heartbeat pair.
// Only started while the auto-send-eve-mail flag is on (the cron route checks).
//
// Safe to retry: a sent or failed row is no longer 'queued', so a retry only
// picks up what is still waiting.

// Both imports live inside the step body on purpose (workflow compiler bans
// Node modules in workflow context — see src/workflows/lib.ts).
async function runStep() {
  'use step'
  const { runJobWithHeartbeat } = await import('./lib')
  await runJobWithHeartbeat('mail-queue-send', async () => (await import('@/app/mail/sendQueue')).runMailQueueSend)
}

export async function mailQueueSendWorkflow() {
  'use workflow'
  await runStep()
}
