import type { SupabaseClient } from '@supabase/supabase-js'
import { forEach, map } from 'ramda'

import { TIME_WINDOW_OPTIONS } from '../timeWindow'
import { CARRY_DAYS, utcDayOf, type ValueRow } from './valuation'

// Read the caller's stored daily values (asset_value_day) for the longest
// window the page offers, plus the carry's lookback so the first day of the
// window can borrow from before it. RLS scopes the rows to the caller's own
// registrations and corporations — the owners fetchOwners() lists.
const PAGE = 1000
const DAY_MS = 86_400_000
const LOOKBACK_DAYS = Math.max(...map((o) => o.days, TIME_WINDOW_OPTIONS)) + CARRY_DAYS

type Stored = {
  registration_id: string | null
  corporation_id: number | string | null
  utc_day: string
  value: number | string
  unpriced_types: number
}

const toRow = (r: Stored): ValueRow => ({
  ownerId: r.registration_id ?? String(r.corporation_id),
  day: r.utc_day,
  value: Number(r.value),
  unpricedTypes: Number(r.unpriced_types),
})

export const fetchValueRows = async (supabase: SupabaseClient, now: number): Promise<ValueRow[]> => {
  const since = utcDayOf(now - LOOKBACK_DAYS * DAY_MS)
  // Owners × days passes PostgREST's row cap on a many-character account, so
  // page tail-recursively, the house shape for unbounded reads.
  const readPage = async (from = 0, acc: ValueRow[] = []): Promise<ValueRow[]> => {
    const { data, error } = await supabase
      .from('asset_value_day')
      .select('registration_id, corporation_id, utc_day, value, unpriced_types')
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
