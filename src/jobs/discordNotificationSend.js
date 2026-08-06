// Sender sweep: pending notification rows → Discord channel messages
// (docs/discord-bot/05-notification-sender.md). Closes the loop stage 04
// opened — detection enqueues, this posts. Unlike the extract jobs it reads
// only our own DB (plus Discord's REST API), but it follows the same
// conventions: name = npm script = heartbeat label = workflow file.
import { recordDiscordSend } from '../observability.js'
import { sudoSupabase } from '../supabase.js'
import {
  classifyDeliveryStatus,
  deliveryPayload,
  isDeliverable,
  MAX_ATTEMPTS,
  retryAfterMs,
} from './discordDelivery.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'discord-notification-send'

// A single sweep's working set. Bounded so one run can't balloon; anything
// left over goes out on the next sweep five minutes later.
const BATCH = 100

const DISCORD_API = 'https://discord.com/api/v10'

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

// Due rows, each joined to its target channel. The embedded select gives the
// channel's snowflake and disabled_at in one round trip.
const selectDueRows = async (now) => {
  const { data, error } = await sudoSupabase
    .from('notification')
    .select('id, body, attempts, scheduled_at, sent_at, discord_channel_id, discord_channel:discord_channel(*)')
    .eq('transport', 'discord')
    .is('sent_at', null)
    .lte('scheduled_at', now.toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .order('scheduled_at', { ascending: true })
    .limit(BATCH)
  if (error) throw error
  return data ?? []
}

const bumpAttempts = (row) =>
  sudoSupabase
    .from('notification')
    .update({ attempts: row.attempts + 1 })
    .eq('id', row.id)

// Post one row. Returns the classified outcome so the caller can tally it.
const deliver = async (row, botToken) => {
  const channel = row.discord_channel
  const startedAt = Date.now()

  const response = await fetch(`${DISCORD_API}/channels/${channel.channel_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(deliveryPayload(row.body)),
  })
  const outcome = classifyDeliveryStatus(response.status)
  recordDiscordSend({ outcome, status: response.status, duration_ms: Date.now() - startedAt })

  if (outcome === 'sent') {
    const { error } = await sudoSupabase
      .from('notification')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', row.id)
    if (error) throw error
    return outcome
  }

  if (outcome === 'disabled') {
    // Permanent: stop pointing at this channel rather than retrying ten times.
    await sudoSupabase.from('discord_channel').update({ disabled_at: new Date().toISOString() }).eq('id', channel.id)
    await bumpAttempts(row)
    return outcome
  }

  if (outcome === 'throttled') {
    const payload = await response.json().catch(() => null)
    await sleep(retryAfterMs(payload))
  }

  await bumpAttempts(row)
  return outcome
}

export const runDiscordNotificationSend = async () => {
  const botToken = process.env.DISCORD_BOT_TOKEN
  if (!botToken) {
    console.log(`[${TAG}] DISCORD_BOT_TOKEN unset — nothing sent`)
    return
  }

  const now = new Date()
  const rows = await selectDueRows(now)
  const tally = { sent: 0, disabled: 0, throttled: 0, retry: 0, skipped: 0 }

  // Sequential: the volume is tiny and serial sends keep us far away from
  // Discord's per-channel rate limits.
  await forEachSequential(rows, async (row) => {
    if (!isDeliverable({ row, channel: row.discord_channel, now })) {
      // Channel deleted or disabled since enqueue — bump so the row eventually
      // ages past the cap instead of being re-selected forever.
      await bumpAttempts(row)
      tally.skipped += 1
      return
    }
    try {
      const outcome = await deliver(row, botToken)
      tally[outcome] += 1
    } catch (e) {
      // One bad row must not abort the sweep; the attempt counter is what
      // eventually retires it.
      console.error(`[${TAG}] row ${row.id} failed`, e)
      await bumpAttempts(row)
      tally.retry += 1
    }
  })

  console.log(
    `[${TAG}] ${rows.length} due: ${tally.sent} sent, ${tally.disabled} channel-disabled, ${tally.throttled} throttled, ${tally.retry} retry, ${tally.skipped} skipped`
  )
}

cli(import.meta.url, TAG, runDiscordNotificationSend)
