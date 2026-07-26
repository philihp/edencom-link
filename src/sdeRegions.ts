// DB-backed lookup over the nightly SDE mirror (the sde_region view — see
// supabase/migrations/20260723000000_sde_taxonomy_views.sql). Resolves a fuzzy
// region name to a region id so region-scoped queries can filter in SQL.
//
// Coverage is k-space only, matching the view (10M id band) and
// sde_kspace_system's exclusion of wormhole/abyssal space.
//
// There is no sde_search_region RPC: the view is ~70 rows, so an ILIKE select
// plus the same coverage ranking searchSdeTypes applies is both cheap and
// exact. Uncached — every caller is a user action, not a per-row render path.
import { escapeLike } from './utils/escapeLike'
import { sdeSupabase } from './utils/supabase/sde'

export type SdeRegion = { regionID: number; name: string }

export type SdeRegionSearchResult = SdeRegion & { coverage: number }

type RegionRow = { region_id: number; name: string | null }

// Same metric as the sde_search_* RPCs: how much of the matched name the query
// accounts for, so "metro" ranks Metropolis above Metropolis-adjacent noise and
// an exact name always wins.
const coverageOf = (query: string, name: string): number => query.length / name.length

export const searchSdeRegions = async (query: string, limit = 25): Promise<SdeRegionSearchResult[]> => {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const { data, error } = await sdeSupabase()
    .from('sde_region')
    .select('region_id, name')
    .ilike('name', `%${escapeLike(trimmed)}%`)
  if (error) {
    console.error(`[sdeRegions] search failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as RegionRow[])
    .flatMap((r) => (r.name ? [{ regionID: r.region_id, name: r.name, coverage: coverageOf(trimmed, r.name) }] : []))
    .sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name) || a.regionID - b.regionID)
    .slice(0, limit)
}
