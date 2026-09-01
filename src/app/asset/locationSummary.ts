import type { SupabaseClient } from '@supabase/supabase-js'
import { forEach } from 'ramda'

// Bigint ids arrive from PostgREST as strings, so every id is kept as a string
// and only converted to a number at the API/system-lookup boundary.
//
// A summary row keyed by whoever owns the stacks: a character (registration
// uuid) or a corporation (EVE corporation id), exactly as fetchOwners() labels
// them.
export type SummaryRow = {
  location_id: number | string
  location_type: string | null
  owner_id: string
  stacks: number | string
}

// Read the caller's location buckets out of asset_location_summary_cache
// (migration 20260901031842).
//
// This used to call character_asset_location_summary() and
// corp_asset_location_summary() per render and hold the result in the Next.js
// data cache, keyed on the most recent asset-extract heartbeat. That cost about
// 6.3 seconds of database time on a cold key — 5,290 ms for the character walk,
// 320 ms for the corp one, and 669 ms for the heartbeat read that existed only
// to compute the key — and the key moved 75 times a day for a nine-character
// account, because character-assets writes one heartbeat per character and the
// heartbeat policy also exposes corp-scoped rows. So the expensive path was the
// common one, not the tail.
//
// The rollup is now maintained by the extract jobs, which means this is a
// primary-key range read of ~500 rows: 0.2 ms measured on production. There is
// nothing left worth caching in front of it, so both the data cache and the
// stamp query are gone.
const PAGE = 1000

export const fetchLocationSummary = async (supabase: SupabaseClient): Promise<SummaryRow[]> => {
  // PostgREST caps a single select, and rows here are (location x owner) pairs
  // — a many-character account can exceed the cap. Page tail-recursively, the
  // house shape for unbounded reads.
  const readPage = async (from = 0, acc: SummaryRow[] = []): Promise<SummaryRow[]> => {
    const { data, error } = await supabase
      .from('asset_location_summary_cache')
      .select('location_id, location_type, owner_id, stacks')
      .order('location_id', { ascending: true })
      .order('owner_id', { ascending: true })
      .range(from, from + PAGE - 1)
    // Returning empty on failure keeps the page rendering, as it did before —
    // but say so, because an empty summary is indistinguishable from "you own
    // nothing" and this table has no live fallback behind it.
    if (error) {
      console.error(`[asset] location summary cache read failed: ${error.message}`)
      return acc
    }
    const rows = (data ?? []) as SummaryRow[]
    forEach((row: SummaryRow) => acc.push(row), rows)
    return rows.length < PAGE ? acc : readPage(from + PAGE, acc)
  }
  return readPage()
}
