import { splitEvery } from 'ramda'

import { marketPrices } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { MIN_PLAUSIBLE_TYPES, normalizeAdjustedPrices, partitionAdjustedPrices } from './adjustedPriceReconcile.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'market-adjusted-prices'

// GET /markets/prices/ → market_adjusted_price_over_time (SCD type 2). CCP's
// adjusted price per type, the price base the game uses to compute an
// industry job's Estimated Item Value — what /structure needs to split a job's
// cost into its index fee, SCC surcharge and facility tax
// (src/app/structure/eiv.ts), and what /blueprint/[itemId] prices each run a
// blueprint made at, as the price stood when the run was installed
// (docs/item-pages.md). Versioned since migration 20261102235206 so that
// second reading never moves: an unchanged price bumps valid_until, a moved
// one closes its row and opens the next, a type CCP stopped publishing is
// closed with no replacement. The like-named view keeps the latest-only
// shape for the readers that want today's price. Public, unauthenticated,
// unpaginated, and free of the ESI error budget — account-wide work like
// industry-systems, so it takes no character scope.

// PostgREST caps a single select; page through every open row so the ~15k
// types never silently truncate the "current" set (which would read as a mass
// delisting to the reconcile). Ordered by type_id — (type_id) where
// is_current is the partial unique index, so this is an index-order walk.
const PAGE = 1000

const fetchCurrentRows = async (from = 0) => {
  const { data, error } = await sudoSupabase
    .from('market_adjusted_price_over_time')
    .select('type_id, adjusted_price, average_price')
    .eq('is_current', true)
    .order('type_id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(from + PAGE))]
}

// Touch, then close, then insert — closing before inserting so the
// one-open-row-per-type unique index never collides mid-run. Rows are
// addressed by type id under the is_current filter, which is what makes a
// type id name exactly one row rather than every closed version of it.
const applyChanges = async (now, { touchIds, closeIds, inserts }) => {
  await forEachSequential(splitEvery(1000, touchIds), async (typeIds) => {
    const { error } = await sudoSupabase
      .from('market_adjusted_price_over_time')
      .update({ valid_until: now })
      .eq('is_current', true)
      .in('type_id', typeIds)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, closeIds), async (typeIds) => {
    const { error } = await sudoSupabase
      .from('market_adjusted_price_over_time')
      .update({ is_current: false, valid_until: now })
      .eq('is_current', true)
      .in('type_id', typeIds)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('market_adjusted_price_over_time').insert(rows)
    if (error) throw error
  })
}

export const runMarketAdjustedPrices = async () => {
  const fetched = normalizeAdjustedPrices(await marketPrices())
  if (fetched.length < MIN_PLAUSIBLE_TYPES) {
    throw new Error(`[${TAG}] only ${fetched.length} type(s) priced; refusing to reconcile a truncated listing`)
  }
  const current = await fetchCurrentRows()
  const changes = partitionAdjustedPrices(current, fetched)
  await applyChanges(new Date().toISOString(), changes)
  console.log(
    `[${TAG}] ${fetched.length} type(s); ${changes.touchIds.length} unchanged, ${changes.inserts.length} opened, ${changes.closeIds.length} closed`
  )
  return changes
}

cli(import.meta.url, TAG, runMarketAdjustedPrices)
