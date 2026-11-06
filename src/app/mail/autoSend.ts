// The experimental `auto-send-eve-mail` Vercel flag. On, MCP send_mail sends
// the mail it has just queued at once, through the same sendQueuedMail a
// person runs from `pnpm run mail-send --queued <id>`, and the mail-queue-send
// cron sends every mail already waiting (src/app/mail/sendQueue.ts); off, the
// tool only queues and the cron returns without starting anything. Meant for
// a person watching the mails arrive: on in development, off in production
// and preview.
//
// The flag is read with the default flagsClient: on Vercel it authenticates
// with the deployment's OIDC token, locally with the VERCEL_OIDC_TOKEN that
// `vercel env pull` writes to .env.local, and either way the credential picks
// the environment whose value is read. Local development points at the
// production database, so a mail auto-sent from a dev server is a real mail.
//
// Fails closed: a flag that cannot be read, or reads as anything but true,
// leaves the mail queued.
import { flagsClient } from '@vercel/flags-core'

export const AUTO_SEND_FLAG = 'auto-send-eve-mail'

export const autoSendEnabled = async (): Promise<boolean> => {
  try {
    const { value } = await flagsClient.evaluate<boolean>(AUTO_SEND_FLAG, false)
    return value === true
  } catch {
    return false
  }
}
