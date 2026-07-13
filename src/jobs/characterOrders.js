import { filter, map, pipe, prop, reduce, splitEvery } from 'ramda'

import { orders } from '../esi.js'
import { recordEsiConditional } from '../observability.js'
import { getEsiEtag, putEsiEtag, sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-orders'
const SCOPE = 'esi-markets.read_character_orders.v1'

// The tracked attributes that define a version of an order row. Two sightings
// with the same signature are the "same" version; any difference (a fill
// lowering volume_remain, or a modify changing price/range/duration) opens a
// new SCD row. issued/timestamps are left out to avoid churn from re-quoting;
// price and duration already move whenever an order is modified.
const signature = (o) =>
  JSON.stringify([
    Number(o.price),
    Number(o.volume_remain),
    o.escrow == null ? null : Number(o.escrow),
    o.min_volume == null ? null : Number(o.min_volume),
    o.range ?? null,
    Number(o.duration),
  ])

// PostgREST caps a single select; page through every open row so a character
// with thousands of orders doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (character_id, cols, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('character_order_over_time')
    .select(cols)
    .eq('character_id', character_id)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(character_id, cols, from + PAGE))]
}

// Reconcile freshly fetched open orders against the character's current (open)
// rows in character_order_over_time (SCD type 2): unchanged orders get their
// last_seen_at extended, changed ones (partial fill, re-price) close their old
// row and open a new one, and vanished ones (filled, expired or cancelled)
// are closed. The character_order view of is_current rows then holds exactly
// the still-open orders.
const reconcile = async (character_id, fetched) => {
  const cols = 'id, order_id, price, volume_remain, escrow, min_volume, range, duration'
  const current = await fetchCurrentRows(character_id, cols)

  const currentByOrder = new Map(current.map((c) => [Number(c.order_id), c]))
  // ESI could report the same order twice if the set shifts mid-response;
  // collapse to one entry per order so we never queue two inserts.
  const fetchedByOrder = new Map(fetched.map((o) => [Number(o.order_id), o]))

  const now = new Date().toISOString()

  // Classify each fetched order against its current row: unchanged (touch),
  // changed (close + insert), or new (insert only). Built with a plain local
  // accumulator mutated via push — a character can hold thousands of orders,
  // and rebuilding immutable arrays on every iteration here would turn an
  // O(n) pass into O(n²).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, o) => {
      const cur = currentByOrder.get(Number(o.order_id))
      if (cur && signature(cur) === signature(o)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        // first_seen_at is left to its `default now()` so it marks this version's debut.
        acc.inserts.push({
          order_id: o.order_id,
          character_id,
          type_id: o.type_id,
          region_id: o.region_id,
          location_id: o.location_id,
          range: o.range,
          // is_buy_order is present (true) only on buy orders; absent means a sell.
          is_buy: o.is_buy_order ?? false,
          is_corporation: o.is_corporation ?? false,
          price: o.price,
          volume_total: o.volume_total,
          volume_remain: o.volume_remain,
          min_volume: o.min_volume ?? null,
          escrow: o.escrow ?? null,
          duration: o.duration,
          issued: o.issued,
          last_seen_at: now,
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    [...fetchedByOrder.values()]
  )

  // Anything still open but not seen this run has filled, expired or cancelled.
  const fetchedIds = new Set(fetchedByOrder.keys())
  const vanishedIds = pipe(
    filter((cur) => !fetchedIds.has(Number(cur.order_id))),
    map(prop('id'))
  )([...currentByOrder.values()])
  const allCloseIds = [...closeIds, ...vanishedIds]

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase.from('character_order_over_time').update({ last_seen_at: now }).in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-order index never collides.
  await forEachSequential(splitEvery(200, allCloseIds), async (ids) => {
    const { error } = await sudoSupabase.from('character_order_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('character_order_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: allCloseIds.length }
}

// GET /characters/{id}/orders/ → character_order_over_time (SCD type 2). ESI's
// open-orders endpoint is a full snapshot, reconciled into versioned history.
// Conditional: a 304 means the open-order set is byte-identical to last run —
// nothing filled, expired or re-priced — so the whole reconcile is skipped.
export const runCharacterOrders = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, name }) => {
    const cacheKey = `${TAG}:${character_id}`
    const priorEtag = await getEsiEtag(cacheKey)
    const t0 = Date.now()
    const { status, json: fetched, etag } = await orders(access_token, characterID, priorEtag)
    const durationMs = Date.now() - t0
    if (status === 304) {
      recordEsiConditional({
        job: TAG,
        characterId: character_id,
        characterName: name,
        outcome: 'not_modified',
        conditional: true,
        durationMs,
      })
      console.log(`[${TAG}] ${name} ${character_id} (${characterID}): not modified`)
      return
    }

    const { touched, opened, closed } = await reconcile(character_id, fetched)

    // Store the ETag only after the reconcile committed, so a mid-run failure
    // never leaves us skipping a fetch whose data we didn't persist.
    await putEsiEtag(cacheKey, etag)
    recordEsiConditional({
      job: TAG,
      characterId: character_id,
      characterName: name,
      outcome: 'modified',
      conditional: priorEtag != null,
      rows: fetched.length,
      durationMs,
    })
    console.log(
      `[${TAG}] ${name} ${character_id} (${characterID}): ${fetched.length} open; ${touched} unchanged, ${opened} opened, ${closed} closed`
    )
  })

cli(import.meta.url, TAG, runCharacterOrders)
