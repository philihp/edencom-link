// Pure decision logic for low-structure-fuel notifications
// (docs/discord-bot/07-structure-fuel-alerts.md): given a structure's stored
// fuel timer and the fresh one, decide whether it just crossed under the
// threshold and compose the outbox rows. Ramda-only and I/O-free so node --test
// can exercise it directly (test/structureFuel.test.ts); the reads/writes live
// in src/jobs/structureFuelNotification.js.
//
// The sibling of src/jobs/denReinforcement.js, and deliberately shaped like it
// — same transition-plus-source-key dedupe, same insert-ready row fan-out.
import { chain } from 'ramda'

// How much fuel is "low". Seven days is the spec's starting point: long enough
// that a weekend of inattention is still recoverable, short enough that a
// well-stocked structure never nags. Per-user thresholds are a follow-up.
export const LOW_FUEL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

// A timestamp as epoch millis, or null for missing/unparsable — timers are
// compared numerically, never as strings (ISO spellings of the same instant
// differ between ESI and Postgres round-trips).
const toEpoch = (timestamp) => {
  if (timestamp == null) return null
  const ms = new Date(timestamp).getTime()
  return Number.isNaN(ms) ? null : ms
}

// The outbox dedupe key: one alert per structure per distinct fuel timer.
// Refuelling pushes fuel_expires forward, minting a new source — which is the
// backstop under the crossing test below, not a replacement for it (the pending
// unique index only guards rows that haven't been sent yet).
export const structureFuelSource = (structureId, fuelExpires) =>
  `structure-fuel:${structureId}:${Math.floor(toEpoch(fuelExpires) / 1000)}`

// Did this structure just cross under the threshold?
//
// The subtlety is what "previously" means. While nobody refuels, the stored
// fuel_expires and the fresh one are the *same instant* — so comparing both
// against `now` can never show a crossing, and the alert would never fire.
// The previous reading has to be judged against the time it was taken, which
// is what corp_structure_status.updated_at records. Yesterday's "7.5 days
// left" is above the line; today's "6.5 days left" is below it, and that pair
// is the crossing. Run again tomorrow and the previous reading is itself below
// the line, so it stays quiet until a refuel lifts it back over.
export const isNewlyLowFuel = ({ prev, next, now = new Date(), thresholdMs = LOW_FUEL_THRESHOLD_MS }) => {
  const nextMs = toEpoch(next?.fuel_expires)
  if (nextMs === null) return false // no fuel timer at all (unfuelled or unanchoring)
  const nowMs = now.getTime()
  // Already dry: this alert warns, it doesn't write obituaries. A daily extract
  // against a 7-day threshold means a live structure always gets warned first.
  if (nextMs <= nowMs) return false
  if (nextMs - nowMs > thresholdMs) return false // still comfortably fuelled

  const prevMs = toEpoch(prev?.fuel_expires)
  const prevAtMs = toEpoch(prev?.updated_at)
  // Never seen before (newly anchored, or the first run after linking a
  // channel) and already low — worth saying once.
  if (prevMs === null || prevAtMs === null) return true
  return prevMs - prevAtMs > thresholdMs
}

// The channel message. <t:…:s> / <t:…:R> are Discord timestamp markup: viewer-
// local wall clock plus a live countdown, the same pair the den ping uses.
// `name` is corp_structure.name (ESI omits it for structures the token can't
// name) and `systemName` comes from the SDE mirror; either may be missing, and
// the id is the last resort. ESI structure names usually already carry the
// system as a prefix, so the parenthetical is only added when it isn't there.
export const composeFuelPing = ({ name, systemName, structureId, fuelExpires }) => {
  const unix = Math.floor(toEpoch(fuelExpires) / 1000)
  const label = name?.trim() || `structure ${structureId}`
  const place = systemName && !label.includes(systemName) ? `${label} (${systemName})` : label
  return {
    subject: 'Structure Fuel Low',
    body: `Structure Low On Fuel - ${place} runs dry at <t:${unix}:s> <t:${unix}:R>`,
  }
}

/**
 * @typedef {{ structure_id: number, system_id?: number | null, name?: string | null, fuel_expires?: string | null }} FuelStructure
 * @typedef {{ fuel_expires?: string | null, updated_at?: string | null }} FuelReading
 * @typedef {{ id: string, user_id: string }} FuelChannel
 */

// The whole decision for one structure: [] unless it just crossed under the
// threshold, else one insert-ready notification row per listening channel
// (delivery state is per-message, so detection fans out here rather than in the
// sender). Unlike the den equivalent the channels span *several* accounts —
// structures are corp-scoped, so every corp member listening gets told — hence
// user_id comes off each channel rather than being passed in.
/**
 * @param {{
 *   structure: FuelStructure,
 *   prev: FuelReading | null,
 *   systemName: string | null,
 *   channels: FuelChannel[],
 *   now?: Date,
 *   thresholdMs?: number,
 * }} params
 */
export const planFuelNotifications = ({
  structure,
  prev,
  systemName,
  channels,
  now = new Date(),
  thresholdMs = LOW_FUEL_THRESHOLD_MS,
}) => {
  if (!isNewlyLowFuel({ prev, next: structure, now, thresholdMs })) return []
  const { structure_id: structureId, fuel_expires: fuelExpires, name } = structure
  const { subject, body } = composeFuelPing({ name, systemName, structureId, fuelExpires })
  const source = structureFuelSource(structureId, fuelExpires)
  return channels.map((channel) => ({
    user_id: channel.user_id,
    source,
    transport: 'discord',
    discord_channel_id: channel.id,
    subject,
    body,
    scheduled_at: now.toISOString(),
  }))
}

// Every row for a run's worth of structures. `prevById` / `systemNames` are
// Maps keyed by structure id and system id; a miss in either is fine (the
// former means "never seen", the latter falls back to the bare name).
/**
 * @param {{
 *   structures: FuelStructure[],
 *   prevById: Map<number, FuelReading>,
 *   systemNames: Map<number, string>,
 *   channels: FuelChannel[],
 *   now?: Date,
 *   thresholdMs?: number,
 * }} params
 */
export const planAllFuelNotifications = ({
  structures,
  prevById,
  systemNames,
  channels,
  now = new Date(),
  thresholdMs = LOW_FUEL_THRESHOLD_MS,
}) =>
  chain(
    (structure) =>
      planFuelNotifications({
        structure,
        prev: prevById.get(Number(structure.structure_id)) ?? null,
        systemName: systemNames.get(Number(structure.system_id)) ?? null,
        channels,
        now,
        thresholdMs,
      }),
    structures
  )
