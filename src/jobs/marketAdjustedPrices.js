import { map, splitEvery } from 'ramda'

import { marketPrices } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'market-adjusted-prices'

// Upsert batch size; well under any payload limit, and small enough that a
// failure re-runs cheaply.
const CHUNK = 500

// GET /markets/prices/ → market_adjusted_price. CCP's adjusted price per type,
// the price base the game uses to compute an industry job's Estimated Item
// Value — which is what /structure needs to split a job's cost into its index
// fee, SCC surcharge and facility tax (src/app/structure/eiv.ts). Latest-only
// upsert rather than SCD-2 on purpose: adjusted_price is a slow-moving smoothed
// average whose day-to-day drift is far below the precision anything downstream
// reports, and versioning it would append ~15k rows a day for no reader (the
// migration comment records the same reasoning). Public, unauthenticated,
// unpaginated, and free of the ESI error budget — account-wide work like
// industry-systems, so it takes no character scope.
export const runMarketAdjustedPrices = async () => {
  const prices = await marketPrices()
  const recorded_at = new Date().toISOString()

  const rows = map(
    (p) => ({
      type_id: p.type_id,
      adjusted_price: p.adjusted_price,
      // Absent for ~13% of types; null means "CCP publishes no average", which
      // is not a price of zero.
      average_price: p.average_price ?? null,
      recorded_at,
    }),
    prices ?? []
  )
  console.log(`[${TAG}] ${rows.length} adjusted price(s) from ESI`)

  await forEachSequential(splitEvery(CHUNK, rows), async (chunk) => {
    const { error } = await sudoSupabase.from('market_adjusted_price').upsert(chunk, { onConflict: 'type_id' })
    if (error) throw new Error(`upsert failed: ${error.message}`)
  })
  console.log(`[${TAG}] upserted ${rows.length} row(s)`)
}

cli(import.meta.url, TAG, runMarketAdjustedPrices)
