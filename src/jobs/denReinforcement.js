// Pure decision logic for mercenary-den reinforcement notifications
// (docs/discord-bot/04-reinforcement-detection.md): given a den's previous and
// fresh status observations, decide whether it just entered reinforcement and
// compose the outbox rows. Ramda-only and I/O-free so node --test can exercise
// it directly (test/denReinforcement.test.ts); the reads/writes live in
// src/jobs/mercenaryDenNotification.js.
import { map } from 'ramda'

// Roman numeral for a planet's celestial index (1 → "I", 4 → "IV", …). Local
// copy of src/sdePlanets.ts's toRoman — that module imports via `@/` and can't
// load under plain `node src/jobs/<job>.js`.
export const toRoman = (n) => {
  if (!Number.isInteger(n) || n <= 0) return String(n)
  const table = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  const [, roman] = table.reduce(
    ([rest, acc], [value, numeral]) =>
      rest >= value ? [rest % value, acc + numeral.repeat(Math.floor(rest / value))] : [rest, acc],
    [n, '']
  )
  return roman
}

// A timestamp as epoch millis, or null for missing/unparsable — timers are
// compared numerically, never as strings (ISO spellings of the same instant
// differ between ESI and Postgres round-trips).
const toEpoch = (timestamp) => {
  if (timestamp == null) return null
  const ms = new Date(timestamp).getTime()
  return Number.isNaN(ms) ? null : ms
}

// The outbox dedupe key: one ping per den per distinct timer. Re-observing the
// same reinforcement next run re-derives the same source and hits the pending
// unique index; a changed timer mints a new source and pings again.
export const denNotificationSource = (denId, reinforcementEnd) =>
  `mercenary-den:${denId}:${Math.floor(toEpoch(reinforcementEnd) / 1000)}`

// Newly reinforced: the fresh observation carries a future timer the previous
// one didn't. Previous null (first-ever observation — user links
// mid-reinforcement and wants the ping), null-end, past-end, or a different
// timestamp all count; the same future timer seen again does not.
export const isNewlyReinforced = (prevObservation, newObservation, now = new Date()) => {
  const next = toEpoch(newObservation?.reinforcement_end)
  if (next === null || next <= now.getTime()) return false
  const prev = toEpoch(prevObservation?.reinforcement_end)
  return prev !== next
}

// The exact message users already paste by hand — keep in lockstep with
// src/app/mercenary-dens/copyDiscordPing.tsx (its enemy=false branch). <t:…:s>
// / <t:…:R> are Discord timestamp markup: viewer-local wall clock + live
// countdown. `planet` is a raw sde_planet row ({ system_name, celestial_index })
// or null when the lookup failed — fall back to the raw planet id.
export const composeDenPing = ({ planet, planetId, reinforcementEnd }) => {
  const unix = Math.floor(toEpoch(reinforcementEnd) / 1000)
  const roman = planet?.celestial_index != null ? ` ${toRoman(planet.celestial_index)}` : ''
  const place = planet?.system_name ? `${planet.system_name}${roman}` : `planet ${planetId}`
  return {
    subject: 'Mercenary Den Reinforced',
    body: `Friendly Den Reinforced - ${place} at <t:${unix}:s> <t:${unix}:R>`,
  }
}

// The whole decision: [] unless the den just entered reinforcement, else one
// insert-ready notification row per linked channel (delivery state is
// per-message, so detection fans out here rather than in the sender).
/**
 * @param {{
 *   userId: string,
 *   denId: number,
 *   planetId: number,
 *   planet: { system_name?: string | null, celestial_index?: number | null } | null,
 *   prevObservation: { reinforcement_end?: string | null } | null,
 *   newObservation: { reinforcement_end?: string | null },
 *   channels: { id: string }[],
 *   now?: Date,
 * }} params
 */
export const planDenNotifications = ({
  userId,
  denId,
  planetId,
  planet,
  prevObservation,
  newObservation,
  channels,
  now = new Date(),
}) => {
  if (!isNewlyReinforced(prevObservation, newObservation, now)) return []
  const reinforcementEnd = newObservation.reinforcement_end
  const { subject, body } = composeDenPing({ planet, planetId, reinforcementEnd })
  const source = denNotificationSource(denId, reinforcementEnd)
  return map(
    (channel) => ({
      user_id: userId,
      source,
      transport: 'discord',
      discord_channel_id: channel.id,
      subject,
      body,
      scheduled_at: now.toISOString(),
    }),
    channels
  )
}
