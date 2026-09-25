import { getSdeTypes } from '@/sdeTypes'
import { sdeSupabase } from '@/utils/supabase/sde'

// Chancellor-set prices for the hulls no market prices (hull_price; see its
// table comment in schema.sql). The ship card and the Appraise button apply
// them through applyHullPrices in src/app/api/appraisal/pricedLines.ts.

// The SDE groups whose hulls get a set price: supercarriers change hands only
// by contract, and so do titans. The Chancellor page lists every published
// type in these groups, so a new hull CCP adds shows up there by itself.
export const TITAN_GROUP_ID = 30
export const SUPERCARRIER_GROUP_ID = 659
export const HULL_PRICE_GROUP_IDS = [SUPERCARRIER_GROUP_ID, TITAN_GROUP_ID]

export type HullPriceRow = { type_id: number; price: number; updated_at: string }

// Every set price. A small table (one row per hull), read on the public anon
// client like market_price. A failed read logs and answers nothing, so an
// appraisal falls back to the market rather than failing.
export const getHullPriceRows = async (): Promise<HullPriceRow[]> => {
  const { data, error } = await sdeSupabase().from('hull_price').select('type_id, price, updated_at')
  if (error) {
    console.error(`[hullPrices] read failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as Array<{ type_id: number | string; price: number | string; updated_at: string }>).map(
    (row) => ({ type_id: Number(row.type_id), price: Number(row.price), updated_at: row.updated_at })
  )
}

// The same prices keyed by item name, the key appraisal lines carry.
export const getHullPricesByName = async (): Promise<Map<string, number>> => {
  const rows = await getHullPriceRows()
  if (rows.length === 0) return new Map()
  const types = await getSdeTypes(rows.map((row) => row.type_id))
  return new Map(
    rows.flatMap((row) => {
      const name = types[row.type_id]?.name
      return name ? [[name, row.price] as [string, number]] : []
    })
  )
}
