import { filter, map, prop, reduce } from 'ramda'

import { characterClones } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-clones'
const SCOPE = 'esi-clones.read_clones.v1'

// GET /characters/{id}/clones/ → character_clone_over_time (SCD type 2), one
// row per clone (the home clone plus every jump clone). Most jump clones sit
// unchanged for a long time, so this tracks history the same way
// character_asset_over_time does, keyed per clone rather than per item.

const cloneKey = (c) => (c.is_home ? 'home' : `jump:${c.jump_clone_id}`)

const signature = (c) =>
  JSON.stringify([
    c.location_id,
    c.location_type ?? null,
    c.name ?? null,
    [...(c.implants ?? [])].sort((a, b) => a - b),
  ])

const fetchCurrentRows = async (character_id) => {
  const { data, error } = await sudoSupabase
    .from('character_clone_over_time')
    .select('id, jump_clone_id, is_home, location_id, location_type, name, implants')
    .eq('character_id', character_id)
    .eq('is_current', true)
  if (error) throw error
  return data ?? []
}

// Reconcile the freshly fetched clones against the character's current (open)
// rows: an unchanged clone gets its last_seen_at extended, a changed clone has
// its old row closed and a new one inserted, and a clone that's gone (jump
// clone destroyed/consumed) is closed.
const reconcile = async (character_id, fetchedClones) => {
  const current = await fetchCurrentRows(character_id)
  const currentByKey = new Map(map((c) => [cloneKey(c), c], current))
  const fetchedByKey = new Map(map((c) => [cloneKey(c), c], fetchedClones))

  const now = new Date().toISOString()

  const { touchIds, closeIds, inserts } = reduce(
    (acc, c) => {
      const cur = currentByKey.get(cloneKey(c))
      if (cur && signature(cur) === signature(c)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        acc.inserts.push({
          character_id,
          jump_clone_id: c.is_home ? null : c.jump_clone_id,
          is_home: !!c.is_home,
          location_id: c.location_id,
          location_type: c.location_type ?? null,
          name: c.name ?? null,
          implants: c.implants ?? [],
          last_seen_at: now,
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
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
      .update({ last_seen_at: now })
      .in('id', touchIds)
    if (error) throw error
  }
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

  return { touched: touchIds.length, opened: inserts.length, closed: allCloseIds.length }
}

export const runCharacterClones = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, ctx }) => {
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
    const { touched, opened, closed } = await reconcile(character_id, [...home, ...jumpClones])
    console.log(`[${TAG}] ${ctx}: ${touched} unchanged, ${opened} opened, ${closed} closed`)
  })

cli(import.meta.url, TAG, runCharacterClones)
