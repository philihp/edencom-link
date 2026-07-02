import { filter, identity, juxt, map, pipe, prop, splitEvery } from 'ramda'

import { assets, assetNames } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCharacter } from './lib.js'

const TAG = 'character-assets'
const SCOPE = 'esi-assets.read_assets.v1'

// GET /characters/{id}/assets/ → character_asset_over_time (SCD type 2), plus
// POST /characters/{id}/assets/names/ for the player-assigned names of singleton
// items fetched in the same pull.

// The tracked attributes that define a version of an item. Two sightings with
// the same signature are the "same" row; any difference opens a new SCD row.
const signature = (a) =>
  JSON.stringify([
    Number(a.type_id),
    a.location_id == null ? null : Number(a.location_id),
    a.location_flag ?? null,
    a.location_type ?? null,
    a.quantity == null ? null : Number(a.quantity),
    a.is_singleton ?? null,
    !!a.is_blueprint_copy,
    a.name ?? null,
  ])

// ESI only names singleton items (assembled ships, containers). Resolve them in
// chunks (the names endpoint caps at 1000 ids) into a Map item_id → name. Best
// effort: a failed chunk just leaves those items unnamed this run.
//
// ESI returns the literal string "None" for singletons with no player-assigned
// name (e.g. blueprints), so treat that sentinel as "no name" rather than text.
const fetchNames = async (access_token, characterID, fetched) => {
  const ids = map(pipe(prop('item_id'), Number), filter(prop('is_singleton'), fetched))
  const names = new Map()
  for (const part of splitEvery(1000, ids)) {
    try {
      const rows = await assetNames(access_token, characterID, part)
      for (const r of rows ?? []) names.set(Number(r.item_id), r.name && r.name !== 'None' ? r.name : null)
    } catch (e) {
      console.error(`[${TAG}] assetNames failed for ${characterID}: ${e?.message}`)
    }
  }
  return names
}

// Reconcile the freshly fetched assets against the character's current (open)
// rows: unchanged items get their last_seen_at extended, changed items have
// their old row closed and a new one inserted, and vanished items are closed.
const reconcile = async (character_id, fetched) => {
  const cols =
    'id, item_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_blueprint_copy, name'
  // Page through every open row: PostgREST caps a select at the API "Max rows"
  // limit (1000), but a character can hold tens of thousands of items. Reading a
  // truncated set makes the un-read items look new, so they'd be re-inserted and
  // collide with their existing current row on character_asset_over_time_current_item_idx.
  const PAGE = 1000
  const current = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sudoSupabase
      .from('character_asset_over_time')
      .select(cols)
      .eq('character_id', character_id)
      .eq('is_current', true)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    current.push(...data)
    if (data.length < PAGE) break
  }

  const byItemId = map(juxt([pipe(prop('item_id'), Number), identity]))
  const currentByItem = new Map(byItemId(current))

  // ESI can return the same item twice across pages if assets shift mid-fetch;
  // collapse to one entry per item so we never queue two inserts for it.
  const fetchedByItem = new Map(byItemId(fetched))
  fetched = [...fetchedByItem.values()]

  const now = new Date().toISOString()
  const touchIds = [] // unchanged: bump last_seen_at on the open row
  const closeIds = [] // changed or gone: close the old open row
  const inserts = [] // changed or new: open a fresh version

  for (const a of fetched) {
    const cur = currentByItem.get(Number(a.item_id))
    if (cur && signature(cur) === signature(a)) {
      touchIds.push(cur.id)
    } else {
      if (cur) closeIds.push(cur.id)
      // first_seen_at is left to its `default now()` so it marks this version's debut.
      inserts.push({
        item_id: a.item_id,
        character_id,
        type_id: a.type_id,
        location_id: a.location_id ?? null,
        location_flag: a.location_flag ?? null,
        location_type: a.location_type ?? null,
        quantity: a.quantity ?? null,
        is_singleton: a.is_singleton ?? null,
        is_blueprint_copy: !!a.is_blueprint_copy,
        last_seen_at: now,
        name: a.name ?? null,
      })
    }
    currentByItem.delete(Number(a.item_id))
  }
  // Anything still open but not seen this run has left the character's assets.
  for (const cur of currentByItem.values()) closeIds.push(cur.id)

  for (const ids of splitEvery(200, touchIds)) {
    const { error: touchErr } = await sudoSupabase
      .from('character_asset_over_time')
      .update({ last_seen_at: now })
      .in('id', ids)
    if (touchErr) throw touchErr
  }
  // Close before inserting so the unique-current-per-item index never collides.
  for (const ids of splitEvery(200, closeIds)) {
    const { error: closeErr } = await sudoSupabase
      .from('character_asset_over_time')
      .update({ is_current: false })
      .in('id', ids)
    if (closeErr) throw closeErr
  }
  for (const rows of splitEvery(1000, inserts)) {
    const { error: insertErr } = await sudoSupabase.from('character_asset_over_time').insert(rows)
    if (insertErr) throw insertErr
  }

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length }
}

export const runCharacterAssets = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, ctx }) => {
    const t0 = Date.now()
    const fetched = await fetchAllPages((page) => assets(access_token, characterID, page))
    const names = await fetchNames(access_token, characterID, fetched)
    const all = map((a) => ({ ...a, name: names.get(Number(a.item_id)) ?? null }), fetched)
    const { touched, opened, closed } = await reconcile(character_id, all)

    const dt = Date.now() - t0
    console.log(
      `[${TAG}] ${ctx}: ${all.length} asset(s); ${touched} unchanged, ${opened} opened, ${closed} closed in ${dt}ms`
    )
  })

cli(import.meta.url, TAG, runCharacterAssets)
