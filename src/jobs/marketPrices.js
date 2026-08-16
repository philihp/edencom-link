import { splitEvery } from 'ramda'

import { TRACKED_MARKETS, fetchMarketPrices } from '../gnfMarket.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'
import { normalizePrices, partitionPrices } from './marketPriceReconcile.js'

const TAG = 'market-prices'

// GET https://appraise.gnf.lt/market/<market>/prices.json →
// market_price_over_time (SCD type 2). Records the best bid and best ask for
// every type the service prices in each tracked market, versioned so the
// spreadsheet's price columns can be reconstructed as of any past moment
// rather than only ever showing "now" (docs/market-prices/README.md).
//
// Account-wide work against a public third-party feed, so — like
// industry-systems — it takes no character scope and runs on the service role.

// PostgREST caps a single select; page through every open row so a market's
// 20k+ types don't silently truncate the "current" set (which would read as a
// mass delisting to the reconcile).
const PAGE = 1000

const fetchCurrentRows = async (market, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('market_price_over_time')
    .select('id, type_id, buy_max, sell_min, strategy')
    .eq('market', market)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(market, from + PAGE))]
}

// Apply one market's classified changes. Ordered exactly like the other SCD-2
// reconciles: touch, then close, then insert — closing before inserting so the
// one-open-row-per-(market, type) unique index never collides mid-run.
const applyChanges = async (now, { touchIds, closeIds, inserts }) => {
  await forEachSequential(splitEvery(1000, touchIds), async (ids) => {
    const { error } = await sudoSupabase.from('market_price_over_time').update({ valid_until: now }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, closeIds), async (ids) => {
    const { error } = await sudoSupabase
      .from('market_price_over_time')
      .update({ is_current: false, valid_until: now })
      .in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('market_price_over_time').insert(rows)
    if (error) throw error
  })
}

// One market's whole pull-and-reconcile. Exported so the workflow can run one
// step per market: each fetch is ~11 MB and each reconcile touches 20k+ rows,
// which together are comfortable inside a step but not stacked into one.
export const syncMarketPrices = async (market) => {
  const feed = await fetchMarketPrices(market)
  const fetched = normalizePrices(feed)
  const current = await fetchCurrentRows(market)
  const changes = partitionPrices(market, current, fetched)
  await applyChanges(new Date().toISOString(), changes)
  console.log(
    `[${TAG}] ${market}: ${fetched.length} type(s); ${changes.touchIds.length} unchanged, ${changes.inserts.length} opened, ${changes.closeIds.length} closed`
  )
  return { market, ...changes }
}

export const runMarketPrices = async ({ markets = TRACKED_MARKETS } = {}) => {
  await forEachSequential(markets, syncMarketPrices)
}

cli(import.meta.url, TAG, runMarketPrices)
