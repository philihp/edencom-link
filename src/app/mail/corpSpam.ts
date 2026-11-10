// The `allow-corp-spam` Vercel flag. Off (the default), MCP send_mail drops
// every corporation from a mail's recipients before it queues it, except the
// corporation that sent the mail a reply_all_to answers. So an auto-responder
// that answers reply-all to a corporation mail writes back to the sender and
// the people on it, not to the whole corporation again. On, nothing is
// dropped.
//
// The flag is read with the default flagsClient: on Vercel it authenticates
// with the deployment's OIDC token, locally with the VERCEL_OIDC_TOKEN that
// `vercel env pull` writes to .env.local.
//
// Fails closed: a flag that cannot be read, or reads as anything but true,
// strips the corporations.
import { flagsClient } from '@vercel/flags-core'

export const CORP_SPAM_FLAG = 'allow-corp-spam'

export const corpSpamAllowed = async (): Promise<boolean> => {
  try {
    const { value } = await flagsClient.evaluate<boolean>(CORP_SPAM_FLAG, false)
    return value === true
  } catch {
    return false
  }
}
