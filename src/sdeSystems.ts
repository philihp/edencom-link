// DB-backed lookup over the nightly SDE mirror (the sde_kspace_system view and
// sde_search_system RPC — see supabase/migrations/20260716010000_sde_mirror.sql).
// Resolves known-space system names and searches by name without an ESI call or
// the old build-time JSON. By-id lookups are cached per server process for 6h
// (misses never cached — see src/sdeCache.ts).
//
// Third loader migrated in the SDE-loaders-to-database cutover
// (docs/sde-db-cutover/01-loader-cutover.md).
import { bulkLookup, createByIdCache } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

export type SdeSystem = { systemID: number; name: string; security: number }

type SystemRow = { system_id: number; name: string; security: number }

const cache = createByIdCache<SdeSystem>()

const rowToSystem = (r: SystemRow): SdeSystem => ({ systemID: r.system_id, name: r.name, security: r.security })

export const getSdeSystems = (systemIDs: Iterable<number>): Promise<Record<number, SdeSystem>> =>
  bulkLookup(cache, systemIDs, async (chunk) => {
    const { data, error } = await sdeSupabase()
      .from('sde_kspace_system')
      .select('system_id, name, security')
      .in('system_id', chunk)
    if (error) {
      console.error(`[sdeSystems] lookup failed: ${error.message}`)
      return []
    }
    return (data ?? []).map((r): [number, SdeSystem] => {
      const s = rowToSystem(r as SystemRow)
      return [s.systemID, s]
    })
  })

export const getSdeSystem = async (systemID: number): Promise<SdeSystem | null> =>
  (await getSdeSystems([systemID]))[systemID] ?? null

export const getSdeSystemNames = async (systemIDs: Iterable<number>): Promise<Record<number, string>> => {
  const systems = await getSdeSystems(systemIDs)
  return Object.fromEntries(Object.entries(systems).map(([id, s]) => [id, s.name]))
}

// EVE shows a system's security status rounded to one decimal. Pure and sync —
// callers already have the security number in hand.
export const formatSecurity = (security: number): string => security.toFixed(1)

export type SdeSystemSearchResult = SdeSystem & { coverage: number }

type SearchRow = { system_id: number; name: string; security: number; coverage: number }

// Search via the sde_search_system RPC, which reproduces the old in-memory
// ranking exactly (coverage desc, shorter name, then id). Mirrors
// searchSdeTypes.
export const searchSdeSystems = async (query: string, limit = 25): Promise<SdeSystemSearchResult[]> => {
  if (query.trim() === '') return []
  const { data, error } = await sdeSupabase().rpc('sde_search_system', { q: query, lim: limit })
  if (error) {
    console.error(`[sdeSystems] search failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as SearchRow[]).map((r) => ({
    systemID: r.system_id,
    name: r.name,
    security: r.security,
    coverage: r.coverage,
  }))
}
