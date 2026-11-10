import { map, splitEvery, sum } from 'ramda'

import { regionSellOrders } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachSequential } from './lib.js'
import { JITA_44, JITA_MARKET, THE_FORGE, toBookRows } from './orderBookFields.js'

const TAG = 'market-depth'

// The SDE groups whose sell books the job keeps: Harvestable Cloud (every
// Fullerite, Mykoserocin and Cytoserocin) and Compressed Gas. The same ids as
// src/app/api/mcp/gasDepth.ts, which reads what this job writes.
const GAS_GROUP_IDS = [711, 4168]

const CHUNK = 500

// GET /markets/{region_id}/orders/?type_id=&order_type=sell →
// market_order_book. Public, no token. The Jita sell book of each reaction gas,
// raw and compressed, so gas_purchase_plan can see how far a large purchase
// walks up the price (docs/edencom-industry-SKILL.md "Buying gas for C-J6MT").
// A snapshot: each type's rows are replaced by what this run saw.
const gasTypeIds = async () => {
  const { data, error } = await sudoSupabase.from('sde_published_type').select('type_id').in('group_id', GAS_GROUP_IDS)
  if (error) throw error
  const ids = map((r) => Number(r.type_id), data ?? [])
  if (ids.length === 0) throw new Error(`[${TAG}] no gas types in sde_published_type; is the SDE mirror empty?`)
  return ids
}

const replaceBook = async (typeId, rows, capturedAt) => {
  await forEachSequential(splitEvery(CHUNK, rows), async (chunk) => {
    const { error } = await sudoSupabase.from('market_order_book').upsert(chunk, { onConflict: 'market,order_id' })
    if (error) throw error
  })
  const { error } = await sudoSupabase
    .from('market_order_book')
    .delete()
    .eq('market', JITA_MARKET)
    .eq('type_id', typeId)
    .lt('captured_at', capturedAt)
  if (error) throw error
}

export const runMarketDepth = async () => {
  const typeIds = await gasTypeIds()
  const capturedAt = new Date().toISOString()
  const toRows = toBookRows(JITA_MARKET, JITA_44, capturedAt)
  const counts = []
  await forEachSequential(typeIds, async (typeId) => {
    const orders = await fetchAllPages((page) => regionSellOrders(THE_FORGE, typeId, page))
    const rows = toRows(orders)
    await replaceBook(typeId, rows, capturedAt)
    counts.push(rows.length)
  })
  const total = sum(counts)
  console.log(`[${TAG}] ${typeIds.length} type(s); ${total} Jita sell order(s)`)
  return { types: typeIds.length, orders: total }
}

cli(import.meta.url, TAG, runMarketDepth)
