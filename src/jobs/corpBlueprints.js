import { filter, map, pipe, prop, reduce, splitEvery } from 'ramda'

import { corpBlueprints } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCorporation, forEachSequential } from './lib.js'

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

// PostgREST caps a single select; page through every open row so a corp with
// thousands of blueprints doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (corporation_id, cols, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('corp_blueprint_over_time')
    .select(cols)
    .eq('corporation_id', corporation_id)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(corporation_id, cols, from + PAGE))]
}

// Reconcile freshly fetched corp blueprints against the corp's current (open)
// rows in corp_blueprint_over_time, the same SCD-2 approach the
// character-blueprints job uses: unchanged blueprints get valid_until
// extended, changed ones close their old row and open a new one, and
// vanished ones are closed.
const reconcile = async (corporation_id, fetched) => {
  const cols = 'id, item_id, type_id, location_id, location_flag, quantity, material_efficiency, time_efficiency, runs'
  const current = await fetchCurrentRows(corporation_id, cols)

  const currentByItem = new Map(current.map((c) => [Number(c.item_id), c]))
  // ESI can return the same item twice across pages if blueprints shift
  // mid-fetch; collapse to one entry per item so we never queue two inserts.
  const fetchedByItem = new Map(fetched.map((b) => [Number(b.item_id), b]))

  const now = new Date().toISOString()

  // Classify each fetched blueprint against its current row: unchanged
  // (touch), changed (close + insert), or new (insert only). Built with a
  // plain local accumulator mutated via push — a corp can hold thousands of
  // blueprints, and rebuilding immutable arrays on every iteration here would
  // turn an O(n) pass into O(n²).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, b) => {
      const cur = currentByItem.get(Number(b.item_id))
      if (cur && signature(cur) === signature(b)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        acc.inserts.push({
          item_id: b.item_id,
          corporation_id,
          type_id: b.type_id,
          location_id: b.location_id ?? null,
          location_flag: b.location_flag ?? null,
          quantity: b.quantity ?? null,
          material_efficiency: b.material_efficiency ?? null,
          time_efficiency: b.time_efficiency ?? null,
          runs: b.runs ?? null,
          valid_until: now,
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    [...fetchedByItem.values()]
  )

  // Anything still open but not seen this run has left the corp's blueprints.
  const fetchedIds = new Set(fetchedByItem.keys())
  const vanishedIds = pipe(
    filter((cur) => !fetchedIds.has(Number(cur.item_id))),
    map(prop('id'))
  )([...currentByItem.values()])
  const allCloseIds = [...closeIds, ...vanishedIds]

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase.from('corp_blueprint_over_time').update({ valid_until: now }).in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-item index never collides.
  await forEachSequential(splitEvery(200, allCloseIds), async (ids) => {
    const { error } = await sudoSupabase.from('corp_blueprint_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('corp_blueprint_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: allCloseIds.length }
}

export const runCorpBlueprints = ({ registrationIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, registrationIds }, async ({ access_token, corporation_id, ctx }) => {
    const t0 = Date.now()
    const fetched = await fetchAllPages((page) => corpBlueprints(access_token, corporation_id, page))
    const { touched, opened, closed } = await reconcile(corporation_id, fetched)
    console.log(
      `[${TAG}] ${ctx}: corp ${corporation_id} ${fetched.length} blueprint(s); ${touched} unchanged, ${opened} opened, ${closed} closed in ${Date.now() - t0}ms`
    )
  })

cli(import.meta.url, TAG, runCorpBlueprints)
