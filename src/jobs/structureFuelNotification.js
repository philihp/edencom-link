// I/O side of low-structure-fuel notifications
// (docs/discord-bot/07-structure-fuel-alerts.md): read the fuel timers the
// previous run stored, resolve system names, plan the rows via the pure seam
// (structureFuel.js), and insert them into the notification outbox. Called from
// corpStructures.js at extract time, so the cron, workflow and CLI paths all
// detect for free — the same shape mercenaryDenNotification.js has for dens.
import { uniq } from 'ramda'

import { sdeAnon } from './sdeAnon.js'
import { sudoSupabase } from '../supabase.js'
import { forEachSequential } from './lib.js'
import { isNewlyLowFuel, planAllFuelNotifications } from './structureFuel.js'

// Who hears about a corp's structures: every account with a live linked channel
// that has a character registered to this corporation — not just the director
// whose token happened to pull the extract. Mirrors what the /structure page's
// RLS implies (corp members see their corp's structures).
export const selectCorpDiscordChannels = async (corporationId) => {
  if (!corporationId) return []

  const { data: registrations, error: regError } = await sudoSupabase
    .from('registration')
    .select('user_id')
    .eq('corporation_id', corporationId)
  if (regError) throw regError

  const userIds = uniq((registrations ?? []).map((r) => r.user_id).filter(Boolean))
  if (userIds.length === 0) return []

  const { data, error } = await sudoSupabase
    .from('discord_channel')
    .select('id, user_id')
    .in('user_id', userIds)
    .is('disabled_at', null)
  if (error) throw error
  return data ?? []
}

// The fuel timers as of the previous run, keyed by structure id. Must be read
// *before* corpStructures upserts the fresh ones over them — updated_at is what
// dates the reading, and the upsert stamps it with this run's clock.
export const selectPreviousFuelStatuses = async (structureIds) => {
  if (structureIds.length === 0) return new Map()
  const { data, error } = await sudoSupabase
    .from('corp_structure_status')
    .select('structure_id, fuel_expires, updated_at')
    .in('structure_id', structureIds)
  if (error) throw error
  return new Map((data ?? []).map((row) => [Number(row.structure_id), row]))
}

// System names from the SDE mirror, keyed by system id. Best-effort: no client
// or a failed lookup degrades to the bare structure name rather than failing
// the extract.
const selectSystemNames = async (systemIds) => {
  const client = sdeAnon()
  if (!client || systemIds.length === 0) return new Map()
  const { data, error } = await client.from('sde_kspace_system').select('system_id, name').in('system_id', systemIds)
  if (error) return new Map()
  return new Map((data ?? []).map((row) => [Number(row.system_id), row.name]))
}

// Enqueue one pending notification per listening channel for every structure
// that just crossed under the fuel threshold. Returns the number of rows
// actually inserted. Per-row inserts so a 23505 (the pending unique index —
// this timer was already enqueued) is swallowed as success without poisoning
// the rest of the fan-out, exactly as den detection does.
export const enqueueLowFuelAlerts = async ({ structures, prevById, channels, now = new Date() }) => {
  if (channels.length === 0) return 0

  // Resolve names only for the structures that will actually ping — the common
  // path is "everything is fuelled" and shouldn't cost an SDE round trip.
  const crossing = structures.filter((structure) =>
    isNewlyLowFuel({ prev: prevById.get(Number(structure.structure_id)) ?? null, next: structure, now })
  )
  if (crossing.length === 0) return 0

  const systemNames = await selectSystemNames(uniq(crossing.map((s) => Number(s.system_id)).filter(Boolean)))
  const rows = planAllFuelNotifications({ structures: crossing, prevById, systemNames, channels, now })

  let inserted = 0
  await forEachSequential(rows, async (row) => {
    const { error } = await sudoSupabase.from('notification').insert(row)
    if (error && error.code !== '23505') throw error
    if (!error) inserted += 1
  })
  return inserted
}
