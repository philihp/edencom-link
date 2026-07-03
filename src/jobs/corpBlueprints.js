import { splitEvery } from 'ramda'

import { corpBlueprints } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCorporation } from './lib.js'

const TAG = 'corp-blueprints'
const SCOPE = 'esi-corporations.read_blueprints.v1'

// GET /corporations/{id}/blueprints/ → corp_blueprint_over_time (SCD type 2),
// mirroring character_blueprint_over_time for the per-character job.

// The tracked attributes that define a version of a corp blueprint row. Two
// sightings with the same signature are the "same" row; any difference opens
// a new SCD row. Mirrors the per-character signature.
const signature = (b) =>
  JSON.stringify([
    Number(b.type_id),
    b.location_id == null ? null : Number(b.location_id),
    b.location_flag ?? null,
    b.quantity == null ? null : Number(b.quantity),
    b.material_efficiency ?? null,
    b.time_efficiency ?? null,
    b.runs ?? null,
  ])

// Reconcile freshly fetched corp blueprints against the corp's current (open)
// rows in corp_blueprint_over_time, the same SCD-2 approach the
// character-blueprints job uses: unchanged blueprints get last_seen_at
// extended, changed ones close their old row and open a new one, and
// vanished ones are closed.
const reconcile = async (corporation_id, fetched) => {
  const cols = 'id, item_id, type_id, location_id, location_flag, quantity, material_efficiency, time_efficiency, runs'
  // Page through every open row: PostgREST caps a select at the API "Max rows"
  // limit (1000), but a corp can hold thousands of blueprints.
  const PAGE = 1000
  const current = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sudoSupabase
      .from('corp_blueprint_over_time')
      .select(cols)
      .eq('corporation_id', corporation_id)
      .eq('is_current', true)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    current.push(...data)
    if (data.length < PAGE) break
  }

  const currentByItem = new Map(current.map((c) => [Number(c.item_id), c]))
  // ESI can return the same item twice across pages if blueprints shift
  // mid-fetch; collapse to one entry per item so we never queue two inserts.
  const fetchedByItem = new Map(fetched.map((b) => [Number(b.item_id), b]))

  const now = new Date().toISOString()
  const touchIds = [] // unchanged: bump last_seen_at on the open row
  const closeIds = [] // changed or gone: close the open row
  const inserts = [] // changed or new: open a fresh version

  for (const b of fetchedByItem.values()) {
    const cur = currentByItem.get(Number(b.item_id))
    if (cur && signature(cur) === signature(b)) {
      touchIds.push(cur.id)
    } else {
      if (cur) closeIds.push(cur.id)
      inserts.push({
        item_id: b.item_id,
        corporation_id,
        type_id: b.type_id,
        location_id: b.location_id ?? null,
        location_flag: b.location_flag ?? null,
        quantity: b.quantity ?? null,
        material_efficiency: b.material_efficiency ?? null,
        time_efficiency: b.time_efficiency ?? null,
        runs: b.runs ?? null,
        last_seen_at: now,
      })
    }
    currentByItem.delete(Number(b.item_id))
  }
  // Anything still open but not seen this run has left the corp's blueprints.
  for (const cur of currentByItem.values()) closeIds.push(cur.id)

  for (const ids of splitEvery(200, touchIds)) {
    const { error } = await sudoSupabase.from('corp_blueprint_over_time').update({ last_seen_at: now }).in('id', ids)
    if (error) throw error
  }
  // Close before inserting so the unique-current-per-item index never collides.
  for (const ids of splitEvery(200, closeIds)) {
    const { error } = await sudoSupabase.from('corp_blueprint_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  }
  for (const rows of splitEvery(1000, inserts)) {
    const { error } = await sudoSupabase.from('corp_blueprint_over_time').insert(rows)
    if (error) throw error
  }

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length }
}

export const runCorpBlueprints = ({ characterIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, characterIds }, async ({ access_token, corporation_id, ctx }) => {
    const t0 = Date.now()
    const fetched = await fetchAllPages((page) => corpBlueprints(access_token, corporation_id, page))
    const { touched, opened, closed } = await reconcile(corporation_id, fetched)
    console.log(
      `[${TAG}] ${ctx}: corp ${corporation_id} ${fetched.length} blueprint(s); ${touched} unchanged, ${opened} opened, ${closed} closed in ${Date.now() - t0}ms`
    )
  })

cli(import.meta.url, TAG, runCorpBlueprints)
