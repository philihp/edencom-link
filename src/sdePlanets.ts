// DB-backed lookup over the nightly SDE mirror (the sde_planet view — see
// supabase/migrations/20260716010000_sde_mirror.sql). Resolves a planet's solar
// system, celestial index, type, and derived display name without an ESI call
// or the old build-time JSON. The view carries system_name directly, so unlike
// the old loader this no longer depends on sdeSystems. The SDE stores no planet
// name (EVE derives it as "<system> <roman(celestialIndex)>"), so `name`/`roman`
// are reconstructed here from the system name + celestial index. By-id lookups
// are cached per server process for 6h (misses never cached — see sdeCache.ts).
//
// Second loader migrated in the SDE-loaders-to-database cutover
// (docs/sde-db-cutover/01-loader-cutover.md).
import { bulkLookup, createByIdCache } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

// Temperate planet type — the planet type mercenary dens deploy to.
export const TEMPERATE_PLANET_TYPE_ID = 11

// EVE's SDE group for planet types (Planet (Temperate), Planet (Lava), …).
// The group's members are the source of truth for what planet types exist, so
// resolvePlanetType never hardcodes a list and a new CCP planet type just works.
export const PLANET_GROUP_ID = 7

export type SdePlanet = {
  planetID: number
  systemID: number
  systemName: string | null
  celestialIndex: number | null
  typeID: number | null
  roman: string | null
  name: string
  // From the view's constellation→region hop and the system's securityStatus
  // (added in 20260723000000_sde_taxonomy_views.sql).
  security: number | null
  regionID: number | null
  regionName: string | null
}

type PlanetRow = {
  planet_id: number
  system_id: number
  celestial_index: number | null
  type_id: number | null
  system_name: string | null
  security: number | null
  region_id: number | null
  region_name: string | null
}

const COLUMNS = 'planet_id, system_id, celestial_index, type_id, system_name, security, region_id, region_name'

// PostgREST caps a response at 1000 rows; a big region runs to a few thousand
// planets, so region reads page. Tail-recursive per CLAUDE.md's pagination
// pattern — the range carries in the arguments, never a mutable loop counter.
const PAGE_SIZE = 1000

const cache = createByIdCache<SdePlanet>()

// Roman numeral for a planet's celestial index (1 → "I", 4 → "IV", …). EVE
// planet indices never get large, but this handles any positive integer.
export const toRoman = (n: number): string => {
  if (!Number.isInteger(n) || n <= 0) return String(n)
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let remaining = n
  let out = ''
  for (const [value, numeral] of table) {
    while (remaining >= value) {
      out += numeral
      remaining -= value
    }
  }
  return out
}

const rowToPlanet = (r: PlanetRow): SdePlanet => {
  const roman = r.celestial_index != null ? toRoman(r.celestial_index) : null
  const name = r.system_name ? `${r.system_name}${roman ? ` ${roman}` : ''}` : `Planet #${r.planet_id}`
  return {
    planetID: r.planet_id,
    systemID: r.system_id,
    systemName: r.system_name,
    celestialIndex: r.celestial_index,
    typeID: r.type_id,
    roman,
    name,
    security: r.security,
    regionID: r.region_id,
    regionName: r.region_name,
  }
}

export const getSdePlanets = (planetIDs: Iterable<number>): Promise<Record<number, SdePlanet>> =>
  bulkLookup(cache, planetIDs, async (chunk) => {
    const { data, error } = await sdeSupabase().from('sde_planet').select(COLUMNS).in('planet_id', chunk)
    if (error) {
      console.error(`[sdePlanets] lookup failed: ${error.message}`)
      return []
    }
    return (data ?? []).map((r): [number, SdePlanet] => {
      const p = rowToPlanet(r as PlanetRow)
      return [p.planetID, p]
    })
  })

export const getSdePlanet = async (planetID: number): Promise<SdePlanet | null> =>
  (await getSdePlanets([planetID]))[planetID] ?? null

// Every planet orbiting the given systems, in celestial order. Uncached (a
// user-action path, unlike the by-id lookups that render every den row) and
// unpaged: a system holds at most a couple of dozen planets, so even a handful
// of systems stays far inside one PostgREST page.
export const getSystemPlanets = async (systemIDs: Iterable<number>): Promise<SdePlanet[]> => {
  const ids = [...new Set(systemIDs)].filter((id) => Number.isFinite(id))
  if (ids.length === 0) return []
  const { data, error } = await sdeSupabase()
    .from('sde_planet')
    .select(COLUMNS)
    .in('system_id', ids)
    .order('system_id')
    .order('celestial_index')
  if (error) {
    console.error(`[sdePlanets] system lookup failed: ${error.message}`)
    return []
  }
  return (data ?? []).map((r) => rowToPlanet(r as PlanetRow))
}

// Every planet in a region, optionally narrowed to certain planet types — the
// "which systems in Metropolis have temperate planets" query, answered as one
// filtered select rather than a region→systems→planets fan-out (which is why
// 20260723000000_sde_taxonomy_views.sql put region_id on the view).
export const getRegionPlanets = async (
  regionID: number,
  planetTypeIDs?: Iterable<number>,
  from = 0,
  acc: SdePlanet[] = []
): Promise<SdePlanet[]> => {
  const typeIDs = planetTypeIDs ? [...planetTypeIDs] : null
  const base = sdeSupabase().from('sde_planet').select(COLUMNS).eq('region_id', regionID)
  const filtered = typeIDs && typeIDs.length > 0 ? base.in('type_id', typeIDs) : base
  const { data, error } = await filtered
    .order('system_id')
    .order('celestial_index')
    .range(from, from + PAGE_SIZE - 1)
  if (error) {
    console.error(`[sdePlanets] region lookup failed: ${error.message}`)
    return acc
  }
  const rows = data ?? []
  rows.forEach((r) => acc.push(rowToPlanet(r as PlanetRow)))
  return rows.length < PAGE_SIZE ? acc : getRegionPlanets(regionID, typeIDs ?? undefined, from + PAGE_SIZE, acc)
}
