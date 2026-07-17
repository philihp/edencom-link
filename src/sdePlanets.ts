// DB-backed lookup over the nightly SDE mirror (the sde_planet view — see
// supabase/migrations/20260716010000_sde_mirror.sql). Resolves a planet's solar
// system, celestial index, type, and derived display name without an ESI call
// or the old build-time JSON. The view carries system_name directly, so unlike
// the old loader this no longer depends on sdeSystems. The SDE stores no planet
// name (EVE derives it as "<system> <roman(celestialIndex)>"), so `name`/`roman`
// are reconstructed here from the system name + celestial index. By-id lookups
// are cached per server process for 6h (misses never cached — see sdeCache.ts).
import { bulkLookup, createByIdCache } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

// Temperate planet type — the planet type mercenary dens deploy to.
export const TEMPERATE_PLANET_TYPE_ID = 11

export type SdePlanet = {
  planetID: number
  systemID: number
  systemName: string | null
  celestialIndex: number | null
  typeID: number | null
  roman: string | null
  name: string
}

type PlanetRow = {
  planet_id: number
  system_id: number
  celestial_index: number | null
  type_id: number | null
  system_name: string | null
}

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
  }
}

export const getSdePlanets = (planetIDs: Iterable<number>): Promise<Record<number, SdePlanet>> =>
  bulkLookup(cache, planetIDs, async (chunk) => {
    const { data, error } = await sdeSupabase()
      .from('sde_planet')
      .select('planet_id, system_id, celestial_index, type_id, system_name')
      .in('planet_id', chunk)
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
