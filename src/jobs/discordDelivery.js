// Pure delivery-outcome logic for the Discord notification sender
// (docs/discord-bot/05-notification-sender.md). What a given Discord REST
// status means for the outbox row and its channel is the part worth pinning in
// tests — the HTTP call itself isn't. I/O lives in discordNotificationSend.js.

// Give up on a row after this many failed attempts: abandoned but still
// visible in the table (the ntfy plan's design), never retried forever.
export const MAX_ATTEMPTS = 10

// What the sweep should do with a row, given Discord's response status.
//
//   'sent'      — 2xx: stamp sent_at, done.
//   'disabled'  — 403/404: the bot was kicked, lost permission, or the channel
//                 is gone. Permanent, so stamp discord_channel.disabled_at
//                 rather than burning MAX_ATTEMPTS; settings shows the state so
//                 the user can re-link.
//   'throttled' — 429: back off and let the next sweep retry.
//   'retry'     — anything else (5xx, network): bump attempts and try again
//                 next sweep until the cap.
export const classifyDeliveryStatus = (status) => {
  if (status >= 200 && status < 300) return 'sent'
  if (status === 403 || status === 404) return 'disabled'
  if (status === 429) return 'throttled'
  return 'retry'
}

// A row is deliverable only while it's pending, due, aimed at a live channel,
// and under the attempt cap. The SQL select already filters on all of these
// except the channel join, which this re-checks so a row whose channel went
// away mid-sweep can't slip through.
export const isDeliverable = ({ row, channel, now = new Date() }) => {
  if (row.sent_at != null) return false
  if (row.attempts >= MAX_ATTEMPTS) return false
  if (new Date(row.scheduled_at).getTime() > now.getTime()) return false
  if (!channel || channel.disabled_at != null) return false
  return true
}

// The message body Discord is asked to post. allowed_mentions parse: [] so
// nothing is ever @-pinged — the <t:…:R> countdown carries the urgency until
// per-channel role-mention config exists (a documented follow-up).
export const deliveryPayload = (body) => ({ content: body, allowed_mentions: { parse: [] } })

// Discord returns { retry_after: <seconds> } on a 429. Clamp to something sane
// — the sweep runs every 5 minutes, so anything longer is better served by
// simply waiting for the next run than by holding the invocation open.
export const retryAfterMs = (payload, cap = 5000) => {
  const seconds = Number(payload?.retry_after)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(seconds * 1000, cap)
}
