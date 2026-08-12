// I/O side of mercenary-den reinforcement notifications
// (docs/discord-bot/04-reinforcement-detection.md): resolve the den's planet to
// a display name, plan the rows via the pure seam (denReinforcement.js), and
// insert them into the notification outbox. Called from
// characterMercenaryDens.js at extract time, so the cron, queue, and CLI paths
// all detect for free.
import { sudoSupabase } from '../supabase.js'
import { isNewlyReinforced, planDenNotifications } from './denReinforcement.js'
import { forEachSequential } from './lib.js'
import { sdeAnon } from './sdeAnon.js'

// The public-read sde_planet view. Missing env or a failed lookup degrades to
// the planet-id fallback body rather than failing the extract — a ping with a
// raw id beats no ping.
const selectPlanet = async (planetId) => {
  const client = sdeAnon()
  if (!client) return null
  const { data, error } = await client
    .from('sde_planet')
    .select('system_name, celestial_index')
    .eq('planet_id', planetId)
    .maybeSingle()
  return error ? null : data
}

// The user's linked Discord channels still in good standing — detection
// consults this before writing anything, so a character with no linked
// channels produces no outbox rows (and skips the per-den history select).
export const selectUserDiscordChannels = async (userId) => {
  if (!userId) return []
  const { data, error } = await sudoSupabase
    .from('discord_channel')
    .select('id')
    .eq('user_id', userId)
    .is('disabled_at', null)
  if (error) throw error
  return data ?? []
}

// Compare the previous and fresh observations and enqueue one pending
// notification per channel if the den just entered reinforcement. Returns the
// number of rows actually inserted. Per-row inserts so a 23505 (the pending
// unique index — this timer was already enqueued) is swallowed as success
// without poisoning the rest of the fan-out.
export const enqueueDenReinforcement = async ({
  userId,
  denId,
  planetId,
  prevObservation,
  newObservation,
  channels,
  now = new Date(),
}) => {
  // Early-out before the SDE lookup — the common path is "nothing changed."
  if (channels.length === 0 || !isNewlyReinforced(prevObservation, newObservation, now)) return 0

  const planet = await selectPlanet(planetId)
  const rows = planDenNotifications({ userId, denId, planetId, planet, prevObservation, newObservation, channels, now })

  let inserted = 0
  await forEachSequential(rows, async (row) => {
    const { error } = await sudoSupabase.from('notification').insert(row)
    if (error && error.code !== '23505') throw error
    if (!error) inserted += 1
  })
  return inserted
}
