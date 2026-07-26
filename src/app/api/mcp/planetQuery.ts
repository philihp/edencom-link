// Filter/shaping seam for the list_planets MCP tool
// (docs/mcp-search-exploration.md, "Planet composition").
//
// Like blueprintQuery.ts and structureQuery.ts this module pulls in no I/O —
// only ramda — so the planet-type matching and the region rollup are
// unit-testable without a Supabase client (see test/planetQuery.test.ts). The
// tool itself does the fetching and hands the rows here.
//
// Row types are declared structurally rather than imported from src/sdePlanets
// so the seam stays free of the loaders' client import.
import { descend, sortWith } from 'ramda'

// Planet ids resolve one select apiece and the response itemizes every one, so
// this is a request-shaping cap, not a safety one — well above any real ask
// (the biggest system has a couple of dozen planets).
export const MAX_PLANET_IDS = 200

export type PlanetLike = {
  planetID: number
  systemID: number
  systemName: string | null
  celestialIndex: number | null
  typeID: number | null
  name: string
  security: number | null
  regionName: string | null
}

export type PlanetTypeLike = { typeID: number; name: string }

// EVE shows security to one decimal; the raw float would read as false
// precision (-0.019999999552965164). Negative zero folds to zero — JSON.stringify
// does that anyway, so normalizing here keeps the in-memory value honest about
// what the caller will actually receive.
export const roundSecurity = (security: number | null): number | null => {
  if (security == null) return null
  const rounded = Number(security.toFixed(1))
  return Object.is(rounded, -0) ? 0 : rounded
}

// Planet type names come from the SDE (never hardcoded), so the display name is
// whatever CCP ships. Callers pass a lookup built from getSdeTypeNames.
export const planetTypeName = (typeNames: Record<number, string>, typeID: number | null): string =>
  typeID == null ? 'Unknown' : (typeNames[typeID] ?? `Type #${typeID}`)

// ── Planet-type resolution ────────────────────────────────────────────────

export type PlanetTypeMatch = { ok: true; typeIDs: number[] | null; names: string[] } | { ok: false; message: string }

// Resolve a fuzzy planet-type query ("lava", "temperate", "Planet (Barren)")
// against the members of SDE group 7. Substring rather than best-match: the
// names share the "Planet (…)" stem, so a query is either specific enough to
// hit one or deliberately broad ("shattered" hits both shattered variants).
export const matchPlanetTypes = (types: PlanetTypeLike[], query: string | undefined): PlanetTypeMatch => {
  const trimmed = (query ?? '').trim()
  if (trimmed === '') return { ok: true, typeIDs: null, names: [] }
  const needle = trimmed.toLowerCase()
  const matches = types.filter((t) => t.name.toLowerCase().includes(needle))
  if (matches.length === 0) {
    const available = types
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b))
      .join(', ')
    return {
      ok: false,
      message: `No planet type matched "${trimmed}". Available planet types: ${available || 'none (the SDE mirror has no planet types yet)'}.`,
    }
  }
  return {
    ok: true,
    typeIDs: matches.map((t) => t.typeID),
    names: matches.map((t) => t.name).sort((a, b) => a.localeCompare(b)),
  }
}

// ── Shaping ───────────────────────────────────────────────────────────────

// Planet-type breakdown of a set of planets, most common first. Insertion
// order is the response order — JSON objects preserve it for string keys.
export const composition = (planets: PlanetLike[], typeNames: Record<number, string>): Record<string, number> => {
  const counts = new Map<string, number>()
  planets.forEach((p) => {
    const name = planetTypeName(typeNames, p.typeID)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  })
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

export type PlanetRowOut = {
  planet_id: number
  name: string
  type: string
  system: string | null
  system_id: number
  region: string | null
  security: number | null
}

// One planet, fully resolved — the shape the ids and system modes itemize.
// `name` is the derived "<system> <roman>" (the SDE stores no planet name).
export const formatPlanet = (planet: PlanetLike, typeNames: Record<number, string>): PlanetRowOut => ({
  planet_id: planet.planetID,
  name: planet.name,
  type: planetTypeName(typeNames, planet.typeID),
  system: planet.systemName,
  system_id: planet.systemID,
  region: planet.regionName,
  security: roundSecurity(planet.security),
})

export type SystemRollup = {
  system: string | null
  system_id: number
  security: number | null
  matching_planets: number
  planets: Record<string, number>
}

// Region mode's per-system rollup: which systems carry the planet types asked
// about, richest first. When no type filter was given every planet counts as
// matching, so the ordering degrades to "most planets first" rather than
// silently reporting zeroes.
export const rollupSystems = (
  planets: PlanetLike[],
  typeNames: Record<number, string>,
  matchingTypeIDs: number[] | null
): SystemRollup[] => {
  const matching = matchingTypeIDs == null ? null : new Set(matchingTypeIDs)
  const bySystem = new Map<number, PlanetLike[]>()
  planets.forEach((p) => {
    const found = bySystem.get(p.systemID)
    if (found) found.push(p)
    else bySystem.set(p.systemID, [p])
  })
  const rollups = [...bySystem.values()].map((group): SystemRollup => {
    const [first] = group
    return {
      system: first.systemName,
      system_id: first.systemID,
      security: roundSecurity(first.security),
      matching_planets:
        matching == null ? group.length : group.filter((p) => p.typeID != null && matching.has(p.typeID)).length,
      planets: composition(group, typeNames),
    }
  })
  return sortWith<SystemRollup>(
    [descend((r) => r.matching_planets), (a, b) => (a.system ?? '').localeCompare(b.system ?? '')],
    rollups
  )
}
