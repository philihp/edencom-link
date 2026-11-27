import type { SupabaseClient } from '@supabase/supabase-js'
import { forEach } from 'ramda'

import { LONGEST_ASSET_WINDOW_DAYS } from './assetWindow'
import { CARRY_DAYS, utcDayOf, type ValueRow } from './valuation'

// Read the caller's stored daily values, every part (asset_value_day) for the longest
// window the page offers, plus the carry's lookback so the first day of the
// window can borrow from before it. RLS scopes the rows to the caller's own
// registrations and corporations — the owners fetchOwners() lists.
const PAGE = 1000
const DAY_MS = 86_400_000
const LOOKBACK_DAYS = LONGEST_ASSET_WINDOW_DAYS + CARRY_DAYS

type Stored = {
  registration_id: string | null
  corporation_id: number | string | null
  utc_day: string
  value: number | string
  job_value: number | string
  sell_order_value: number | string
  buy_escrow: number | string
  contract_value: number | string
  wallet: number | string
  unpriced_types: number
}

const toRow = (r: Stored): ValueRow => ({
  ownerId: r.registration_id ?? String(r.corporation_id),
  day: r.utc_day,
  parts: {
    hangar: Number(r.value),
    jobs: Number(r.job_value),
    market: Number(r.sell_order_value) + Number(r.buy_escrow),
    contracts: Number(r.contract_value),
    cash: Number(r.wallet),
  },
  unpricedTypes: Number(r.unpriced_types),
})

export const fetchValueRows = async (supabase: SupabaseClient, now: number): Promise<ValueRow[]> => {
  const since = utcDayOf(now - LOOKBACK_DAYS * DAY_MS)
  // Owners × days passes PostgREST's row cap on a many-character account, so
  // page tail-recursively, the house shape for unbounded reads.
  const readPage = async (from = 0, acc: ValueRow[] = []): Promise<ValueRow[]> => {
    const { data, error } = await supabase
      .from('asset_value_day')
      .select(
        'registration_id, corporation_id, utc_day, value, job_value, sell_order_value, buy_escrow, contract_value, wallet, unpriced_types'
      )
      .gte('utc_day', since)
      .order('owner_key', { ascending: true })
      .order('utc_day', { ascending: true })
      .range(from, from + PAGE - 1)
    // The chart is the page's top half, not all of it: say so and draw the
    // locations anyway.
    if (error) {
      console.error(`[asset] valuation read failed: ${error.message}`)
      return acc
    }
    const rows = (data ?? []) as Stored[]
    forEach((r: Stored) => acc.push(toRow(r)), rows)
    return rows.length < PAGE ? acc : readPage(from + PAGE, acc)
  }
  return readPage()
}
