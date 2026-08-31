import { filter, map, pipe, prop, reduce, splitEvery } from 'ramda'

import { blueprints } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { claimRows, cli, fetchAllPages, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-blueprints'
const SCOPE = 'esi-characters.read_blueprints.v1'

// GET /characters/{id}/blueprints/ → character_blueprint_over_time (SCD type
// 2). Mirrors the character-assets job's reconcile approach: each blueprint
// instance's location, stack/copy state (quantity) and research level
// (material_efficiency/time_efficiency/runs) is tracked as a versioned
// history rather than overwritten in place.

// The tracked attributes that define a version of a blueprint row. Two
// sightings with the same signature are the "same" row; any difference opens
// a new SCD row.
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

// PostgREST caps a single select; page through every open row so a character
// with thousands of blueprints doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (registration_id, cols, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('character_blueprint_over_time')
    .select(cols)
    .eq('registration_id', registration_id)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(registration_id, cols, from + PAGE))]
}

// Reconcile freshly fetched blueprints against the character's current (open)
// rows: unchanged blueprints get their valid_until extended, changed ones
// have their old row closed and a new one inserted, and vanished ones
// (scrapped, transferred away, converted) are closed.
const reconcile = async (registration_id, fetched) => {
  const cols = 'id, item_id, type_id, location_id, location_flag, quantity, material_efficiency, time_efficiency, runs'
  const current = await fetchCurrentRows(registration_id, cols)

  const currentByItem = new Map(current.map((c) => [Number(c.item_id), c]))
  // ESI can return the same item twice across pages if blueprints shift
  // mid-fetch; collapse to one entry per item so we never queue two inserts.
  const fetchedByItem = new Map(fetched.map((b) => [Number(b.item_id), b]))

  const now = new Date().toISOString()

  // Classify each fetched blueprint against its current row: unchanged
  // (touch), changed (close + insert), or new (insert only). Built with a
  // plain local accumulator mutated via push — a character can hold thousands
  // of blueprints, and rebuilding immutable arrays on every iteration here
  // would turn an O(n) pass into O(n²).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, b) => {
      const cur = currentByItem.get(Number(b.item_id))
      if (cur && signature(cur) === signature(b)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        // valid_from is left to its `default now()` so it marks this version's debut.
        acc.inserts.push({
          item_id: b.item_id,
          registration_id,
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

  // Anything still open but not seen this run has left the character's blueprints.
  const fetchedIds = new Set(fetchedByItem.keys())
  const vanishedIds = pipe(
    filter((cur) => !fetchedIds.has(Number(cur.item_id))),
    map(prop('id'))
  )([...currentByItem.values()])
  const allCloseIds = [...closeIds, ...vanishedIds]

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error: touchErr } = await sudoSupabase
      .from('character_blueprint_over_time')
      .update({ valid_until: now })
      .in('id', ids)
    if (touchErr) throw touchErr
  })
  // Close this owner's superseded and vanished rows. The claim below handles
  // the open row of any *other* owner whose item we are taking over.
  await forEachSequential(splitEvery(200, allCloseIds), async (ids) => {
    const { error: closeErr } = await sudoSupabase
      .from('character_blueprint_over_time')
      .update({ is_current: false })
      .in('id', ids)
    if (closeErr) throw closeErr
  })
  // Open the new versions through the claim function: it also closes any open
  // row for these item_ids under a *different* owner, which is what an item
  // changing hands looks like and what a plain insert collided with.
  const opened = await claimRows('character_blueprint_claim', inserts)

  return { touched: touchIds.length, opened, closed: allCloseIds.length }
}

export const runCharacterBlueprints = ({ registrationIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, registrationIds },
    async ({ access_token, characterID, registration_id, ctx }) => {
      const t0 = Date.now()
      const fetched = await fetchAllPages((page) => blueprints(access_token, characterID, page))
      const { touched, opened, closed } = await reconcile(registration_id, fetched)

      const dt = Date.now() - t0
      console.log(
        `[${TAG}] ${ctx}: ${fetched.length} blueprint(s); ${touched} unchanged, ${opened} opened, ${closed} closed in ${dt}ms`
      )
    }
  )

cli(import.meta.url, TAG, runCharacterBlueprints)
