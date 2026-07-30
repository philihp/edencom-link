import { filter, map, prop, reduce } from 'ramda'

import { characterClones, universeStation, universeStructure } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-clones'
export const SCOPE = 'esi-clones.read_clones.v1'

// GET /characters/{id}/clones/ → character_clone_over_time (SCD type 2), one
// row per clone (the home clone plus every jump clone). Most jump clones sit
// unchanged for a long time, so this tracks history the same way
// character_asset_over_time does, keyed per clone rather than per item.
// The payload's character-level timestamps (last_clone_jump_date,
// last_station_change_date) go to character_clone_state, a live one-row-per-
// character table like character_location.

const cloneKey = (c) => (c.is_home ? 'home' : `jump:${c.jump_clone_id}`)

// system_id is derived from location_id, so it's deliberately not part of the
// signature: a late-resolving system backfills the open row (see reconcile)
// instead of closing it and opening a new one.
const signature = (c) =>
  JSON.stringify([
    c.location_id,
    c.location_type ?? null,
    c.name ?? null,
    [...(c.implants ?? [])].sort((a, b) => a - b),
  ])

// Resolve each clone's station/structure to its solar system, memoized across
// every character in the run (clones cluster in the same few locations).
// NPC stations resolve via the public /universe/stations/ endpoint; player
// structures via the universe_structure cache, falling back to an ESI call
// with the character's own token (403 if it can't dock — the daily
// universe-structures job pools clone locations too, so another character's
// token may backfill it later). Unresolvable locations stay null.
export const makeSystemResolver = () => {
  const memo = new Map()
  return async (location_id, location_type, access_token) => {
    if (memo.has(location_id)) return memo.get(location_id)
    let system_id = null
    try {
      if (location_type === 'station') {
        const station = await universeStation(location_id)
        system_id = station?.system_id ?? null
      } else if (location_type === 'structure') {
        const { data } = await sudoSupabase
          .from('universe_structure')
          .select('system_id')
          .eq('structure_id', location_id)
          .maybeSingle()
        if (data?.system_id != null) {
          system_id = Number(data.system_id)
        } else {
          const info = await universeStructure(access_token, location_id)
          system_id = info?.solar_system_id ?? null
          if (system_id != null) {
            await sudoSupabase.from('universe_structure').upsert(
              {
                structure_id: location_id,
                name: info?.name ?? null,
                system_id,
                type_id: info?.type_id ?? null,
                resolved_at: new Date().toISOString(),
              },
              { onConflict: 'structure_id' }
            )
          }
        }
      }
    } catch (e) {
      console.warn(`[${TAG}] system for ${location_type} ${location_id} unresolved: ${e?.message}`)
    }
    memo.set(location_id, system_id)
    return system_id
  }
}

const fetchCurrentRows = async (registration_id) => {
  const { data, error } = await sudoSupabase
    .from('character_clone_over_time')
    .select('id, jump_clone_id, is_home, location_id, location_type, name, implants, system_id')
    .eq('character_id', registration_id)
    .eq('is_current', true)
  if (error) throw error
  return data ?? []
}

// Reconcile the freshly fetched clones against the character's current (open)
// rows: an unchanged clone gets its valid_until extended (and its system_id
// backfilled if resolution newly succeeded), a changed clone has its old row
// closed and a new one inserted, and a clone that's gone (jump clone
// destroyed/consumed) is closed.
const reconcile = async (registration_id, fetchedClones) => {
  const current = await fetchCurrentRows(registration_id)
  const currentByKey = new Map(map((c) => [cloneKey(c), c], current))
  const fetchedByKey = new Map(map((c) => [cloneKey(c), c], fetchedClones))

  const now = new Date().toISOString()

  const { touchIds, retags, closeIds, inserts } = reduce(
    (acc, c) => {
      const cur = currentByKey.get(cloneKey(c))
      if (cur && signature(cur) === signature(c)) {
        if (c.system_id != null && Number(cur.system_id ?? NaN) !== c.system_id) {
          acc.retags.push({ id: cur.id, system_id: c.system_id })
        } else {
          acc.touchIds.push(cur.id)
        }
      } else {
        if (cur) acc.closeIds.push(cur.id)
        acc.inserts.push({
          character_id: registration_id,
          jump_clone_id: c.is_home ? null : c.jump_clone_id,
          is_home: !!c.is_home,
          location_id: c.location_id,
          location_type: c.location_type ?? null,
          name: c.name ?? null,
          implants: c.implants ?? [],
          system_id: c.system_id ?? null,
          valid_until: now,
        })
      }
      return acc
    },
    { touchIds: [], retags: [], closeIds: [], inserts: [] },
    [...fetchedByKey.values()]
  )

  const fetchedKeys = new Set(fetchedByKey.keys())
  const vanishedIds = map(
    prop('id'),
    filter((cur) => !fetchedKeys.has(cloneKey(cur)), [...currentByKey.values()])
  )
  const allCloseIds = [...closeIds, ...vanishedIds]

  if (touchIds.length) {
    const { error } = await sudoSupabase
      .from('character_clone_over_time')
      .update({ valid_until: now })
      .in('id', touchIds)
    if (error) throw error
  }
  // Unchanged rows whose location just became resolvable: backfill system_id
  // per row (each may resolve to a different system) while extending valid_until.
  await forEachSequential(retags, async ({ id, system_id }) => {
    const { error } = await sudoSupabase
      .from('character_clone_over_time')
      .update({ valid_until: now, system_id })
      .eq('id', id)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-clone indexes never collide.
  if (allCloseIds.length) {
    const { error } = await sudoSupabase
      .from('character_clone_over_time')
      .update({ is_current: false })
      .in('id', allCloseIds)
    if (error) throw error
  }
  if (inserts.length) {
    const { error } = await sudoSupabase.from('character_clone_over_time').insert(inserts)
    if (error) throw error
  }

  return { touched: touchIds.length + retags.length, opened: inserts.length, closed: allCloseIds.length }
}

// One character's clone pull. Takes a `resolveSystem` memo (from
// makeSystemResolver) so a whole run's clones — which cluster in the same few
// stations/structures — resolve each location once. Exported so the combined
// character-status job (characterStatus.js) can reuse it with a shared resolver.
export const syncCharacterClones = async ({ access_token, characterID, registration_id, ctx }, resolveSystem) => {
  const payload = await characterClones(access_token, characterID)
  const home = payload.home_location
    ? [
        {
          is_home: true,
          location_id: payload.home_location.location_id,
          location_type: payload.home_location.location_type ?? null,
          implants: [],
        },
      ]
    : []
  const jumpClones = map(
    (c) => ({
      is_home: false,
      jump_clone_id: c.jump_clone_id,
      location_id: c.location_id,
      location_type: c.location_type ?? null,
      name: c.name ?? null,
      implants: c.implants ?? [],
    }),
    payload.jump_clones ?? []
  )
  const clones = [...home, ...jumpClones]
  await forEachSequential(clones, async (c) => {
    c.system_id = await resolveSystem(c.location_id, c.location_type, access_token)
  })

  const { error: stateErr } = await sudoSupabase.from('character_clone_state').upsert(
    {
      character_id: registration_id,
      last_clone_jump_date: payload.last_clone_jump_date ?? null,
      last_station_change_date: payload.last_station_change_date ?? null,
      recorded_at: new Date().toISOString(),
    },
    { onConflict: 'character_id' }
  )
  if (stateErr) throw stateErr

  const { touched, opened, closed } = await reconcile(registration_id, clones)
  console.log(`[${TAG}] ${ctx}: ${touched} unchanged, ${opened} opened, ${closed} closed`)
}

export const runCharacterClones = ({ characterIds } = {}) => {
  const resolveSystem = makeSystemResolver()
  return forEachCharacter(TAG, { scope: SCOPE, characterIds }, (handlerCtx) =>
    syncCharacterClones(handlerCtx, resolveSystem)
  )
}

cli(import.meta.url, TAG, runCharacterClones)
