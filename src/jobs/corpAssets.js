import { forEach, reduce, splitEvery } from 'ramda'

import { corpAssets } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCorporation, forEachSequential } from './lib.js'

const TAG = 'corp-assets'
export const SCOPE = 'esi-assets.read_corporation_assets.v1'

// GET /corporations/{id}/assets/ → corp_asset_over_time (SCD type 2) and
// corp_structure_rig. ESI has no dedicated structure-fitting endpoint; rigs come
// from this same assets pull as items whose location_id is one of our structures
// and whose location_flag is a RigSlot.

// Items fitted to an Upwell structure show up in corp assets with location_id
// equal to the structure_id and a RigSlotN location_flag.
const isRigSlot = (flag) => typeof flag === 'string' && flag.startsWith('RigSlot')

// The tracked attributes that define a version of a corp asset row. Two
// sightings with the same signature are the "same" row; any difference opens
// a new SCD row. Mirrors the per-character signature (minus `name`, which ESI
// doesn't expose for corp assets).
const signature = (a) =>
  JSON.stringify([
    Number(a.type_id),
    a.location_id == null ? null : Number(a.location_id),
    a.location_flag ?? null,
    a.location_type ?? null,
    a.quantity == null ? null : Number(a.quantity),
    a.is_singleton ?? null,
    !!a.is_blueprint_copy,
  ])

// PostgREST caps a single select; page through every open row so a large corp
// hangar doesn't silently truncate the "current" set. Each page is folded into
// a compact item_id → { id, sig } map as it arrives and then discarded — the
// classify step only ever compares signatures, so holding every current row's
// full columns just multiplied peak memory (see the character-assets twin).
const PAGE = 1000

const fetchCurrentByItem = async (corporation_id) => {
  const cols =
    'id, item_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_blueprint_copy'
  const byItem = new Map()
  const fetchPage = async (from) => {
    const { data, error } = await sudoSupabase
      .from('corp_asset_over_time')
      .select(cols)
      .eq('corporation_id', corporation_id)
      .eq('is_current', true)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const page = data ?? []
    forEach((c) => byItem.set(Number(c.item_id), { id: c.id, sig: signature(c) }), page)
    if (page.length === PAGE) await fetchPage(from + PAGE)
  }
  await fetchPage(0)
  return byItem
}

// Reconcile freshly fetched corp assets against the corp's current (open) rows
// in corp_asset_over_time, the same SCD-2 approach the character-assets job uses
// for per-character assets: unchanged items get valid_until extended, changed
// items close their old row and open a new one, and vanished items are closed.
const reconcile = async (corporation_id, fetched) => {
  const currentByItem = await fetchCurrentByItem(corporation_id)
  // ESI can return the same item twice across pages if assets shift mid-fetch;
  // collapse to one entry per item so we never queue two inserts for it.
  const fetchedByItem = new Map(fetched.map((a) => [Number(a.item_id), a]))

  const now = new Date().toISOString()

  // Classify each fetched item against its current row: unchanged (touch),
  // changed (close + insert), or new (insert only). Built with a plain local
  // accumulator mutated via push — a corp can hold tens of thousands of items,
  // and rebuilding immutable arrays on every iteration here would turn an
  // O(n) pass into O(n²).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, a) => {
      const cur = currentByItem.get(Number(a.item_id))
      if (cur && cur.sig === signature(a)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        acc.inserts.push({
          item_id: a.item_id,
          corporation_id,
          type_id: a.type_id,
          location_id: a.location_id ?? null,
          location_flag: a.location_flag ?? null,
          location_type: a.location_type ?? null,
          quantity: a.quantity ?? null,
          is_singleton: a.is_singleton ?? null,
          is_blueprint_copy: !!a.is_blueprint_copy,
          valid_until: now,
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    [...fetchedByItem.values()]
  )

  // Anything still open but not seen this run has left the corp's assets.
  const vanishedIds = []
  currentByItem.forEach(({ id }, itemId) => {
    if (!fetchedByItem.has(itemId)) vanishedIds.push(id)
  })
  const allCloseIds = [...closeIds, ...vanishedIds]

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase.from('corp_asset_over_time').update({ valid_until: now }).in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-item index never collides.
  await forEachSequential(splitEvery(200, allCloseIds), async (ids) => {
    const { error } = await sudoSupabase.from('corp_asset_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('corp_asset_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: allCloseIds.length }
}

export const runCorpAssets = ({ characterIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, characterIds }, async ({ access_token, corporation_id, ctx }) => {
    const t0 = Date.now()

    // Our structures double as asset location_ids; only keep rigs fitted to them.
    const { data: ownStructures, error: ownErr } = await sudoSupabase
      .from('corp_structure')
      .select('structure_id')
      .eq('corporation_id', corporation_id)
    if (ownErr) throw ownErr
    const structureIds = new Set((ownStructures ?? []).map((s) => Number(s.structure_id)))

    const assets = await fetchAllPages((page) => corpAssets(access_token, corporation_id, page))
    const { touched, opened, closed } = await reconcile(corporation_id, assets)
    console.log(
      `[${TAG}] ${ctx}: corp ${corporation_id} ${assets.length} asset(s); ${touched} unchanged, ${opened} opened, ${closed} closed`
    )

    const now = new Date().toISOString()
    const rigRows = assets
      .filter((a) => isRigSlot(a.location_flag) && structureIds.has(Number(a.location_id)))
      .map((a) => ({
        structure_id: a.location_id,
        location_flag: a.location_flag,
        type_id: a.type_id,
        corporation_id,
        updated_at: now,
      }))

    // Replace this corp's rig rows wholesale so removed/swapped rigs don't linger.
    if (structureIds.size > 0) {
      const { error: delErr } = await sudoSupabase
        .from('corp_structure_rig')
        .delete()
        .eq('corporation_id', corporation_id)
      if (delErr) throw delErr
    }
    if (rigRows.length > 0) {
      const { error: rigErr } = await sudoSupabase
        .from('corp_structure_rig')
        .upsert(rigRows, { onConflict: 'structure_id,location_flag' })
      if (rigErr) throw rigErr
    }
    console.log(
      `[${TAG}] ${ctx}: corp ${corporation_id} stored ${rigRows.length} structure rig(s) in ${Date.now() - t0}ms`
    )
  })

cli(import.meta.url, TAG, runCorpAssets)
