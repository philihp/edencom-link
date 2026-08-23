import type { SupabaseClient } from '@supabase/supabase-js'
import { unstable_cache } from 'next/cache'
import { map } from 'ramda'

// Bigint ids arrive from PostgREST as strings, so every id is kept as a string
// and only converted to a number at the API/system-lookup boundary.
type CharacterSummaryRow = {
  location_id: number | string
  location_type: string | null
  registration_id: string
  stacks: number | string
}

type CorpSummaryRow = {
  location_id: number | string
  location_type: string | null
  corporation_id: number | string
  stacks: number | string
}

// A summary row from either source, keyed by whoever owns the stacks: a
// character (registration uuid) or a corporation (EVE corporation id).
export type SummaryRow = {
  location_id: number | string
  location_type: string | null
  owner_id: string
  stacks: number | string
}

// The two extract jobs whose completion can move an asset's location bucket.
const ASSET_JOBS = ['character-assets', 'corp-assets']

// A stamp that changes exactly when the caller's asset data can have changed:
// the most recent completion of either asset extract they can see. `ended_at`
// only ever moves forward, so the max across both jobs is enough — there is no
// need to track the two separately. RLS scopes the read the same way it scopes
// the assets themselves (own character rows, plus corp rows for corps we have a
// registered character in), so a corp extract another member's account
// triggered still moves our stamp. Indexed by heartbeat_job_ended_at_idx.
export const assetExtractStamp = async (supabase: SupabaseClient): Promise<string> => {
  const { data } = await supabase
    .from('heartbeat')
    .select('ended_at')
    .in('job', ASSET_JOBS)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.ended_at ?? 'never'
}

// character_asset_location_summary() and corp_asset_location_summary() walk
// *every* current asset up its container chain to bucket it by location —
// ~600ms and ~130ms on production (see the header of migration
// 20260807010000_asset_location_summary_scope.sql). They were being paid on
// every render, to produce ~1.5k rows from data that only changes when the
// 6-hourly extract runs.
//
// So key the result on the caller plus that extract's completion stamp and put
// it in the data cache. A new stamp is a new key, which is what makes this
// safe: nothing is ever served across an extract, including an on-demand
// "Refresh ESI" (the dispatched job writes a heartbeat when it finishes, after
// its reconcile has landed). `revalidate` is only the backstop for a key that
// somehow stops moving; an hour is far inside the 6-hour cadence.
//
// The user id is in the key because these rows are RLS-scoped to the caller and
// the data cache is not — two accounts must never share an entry.
//
// This is the cheap half of the fix. The real one is to stop recomputing the
// walk per request at all (a rollup table maintained by the extract job), which
// would also help /asset/[locationId] and the MCP browse_assets tool; this
// helps only what renders through here.
const CACHE_TTL_SECONDS = 3600

export const fetchLocationSummary = async (
  supabase: SupabaseClient,
  userId: string,
  stamp: string
): Promise<SummaryRow[]> => {
  const load = unstable_cache(
    async (): Promise<SummaryRow[]> => {
      const [{ data: characterSummary, error: characterError }, { data: corpSummary, error: corpError }] =
        await Promise.all([
          supabase.rpc('character_asset_location_summary'),
          supabase.rpc('corp_asset_location_summary'),
        ])
      // Throw rather than fall back to empty: an empty result is indistinguishable
      // from "you own nothing", and caching that for an hour would turn a blip
      // into an hour of a blank asset page. A rejected callback is not cached.
      if (characterError) throw characterError
      if (corpError) throw corpError
      return [
        ...map(
          (row: CharacterSummaryRow): SummaryRow => ({ ...row, owner_id: row.registration_id }),
          (characterSummary ?? []) as CharacterSummaryRow[]
        ),
        ...map(
          (row: CorpSummaryRow): SummaryRow => ({ ...row, owner_id: String(row.corporation_id) }),
          (corpSummary ?? []) as CorpSummaryRow[]
        ),
      ]
    },
    ['asset-location-summary', userId, stamp],
    { revalidate: CACHE_TTL_SECONDS }
  )

  // The page rendered an empty table when these RPCs failed; keep that, but
  // decide it out here so the failure never reaches the cache.
  return load().catch((error) => {
    console.error(`[asset] location summary failed: ${error?.message ?? error}`)
    return []
  })
}
