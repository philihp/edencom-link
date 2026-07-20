// Resolve display names + solar systems for a set of root locations (a
// station, a player structure, or a bare solar system) — the logic the assets
// pages share: our own corp's structures (corp_structure) win over the
// ESI-resolved cache (universe_structure) for player structures; NPC station
// names and solar system names come from the universe_name cache.
import type { SupabaseClient } from '@supabase/supabase-js'
import { chain, filter, map, pipe } from 'ramda'
import { createClient } from '@/utils/supabase/server'
import { fetchStationNames, fetchStationSystems } from './stationNames'
import { fetchSystemNames } from './systemNames'

export type LocationRef = { id: string; type: string | null }

type Structure = { structure_id: number | string; name: string | null; system_id: number | string | null }

export type ResolvedLocations = {
  nameFor: (loc: LocationRef) => string
  systemFor: (loc: LocationRef) => string | undefined
  systemIdFor: (loc: LocationRef) => number | undefined
}

export const resolveLocations = async (
  locations: LocationRef[],
  client?: SupabaseClient
): Promise<ResolvedLocations> => {
  const supabase = client ?? (await createClient())
  const locationIds = filter(
    Number.isFinite,
    map((l: LocationRef) => Number(l.id), locations)
  )

  const [{ data: corpStructures }, { data: playerStructures }] = await Promise.all([
    supabase.from('corp_structure').select('structure_id, name, system_id'),
    locationIds.length
      ? supabase.from('universe_structure').select('structure_id, name, system_id').in('structure_id', locationIds)
      : Promise.resolve({ data: [] }),
  ])

  // Own-corp structures override the ESI-resolved cache (later entries win).
  const byStructureId = (list: Structure[]): [string, Structure][] => map((s) => [String(s.structure_id), s], list)
  const structureById = new Map<string, Structure>([
    ...byStructureId((playerStructures ?? []) as Structure[]),
    ...byStructureId((corpStructures ?? []) as Structure[]),
  ])

  // NPC station names come from the universe_name DB cache; player structures
  // aren't there, so those still resolve via corp_structure above.
  const stationIds = pipe(
    filter((l: LocationRef) => l.type === 'station'),
    map((l: LocationRef) => Number(l.id))
  )(locations)
  const [stationNames, stationSystems] = await Promise.all([
    fetchStationNames(stationIds, supabase),
    fetchStationSystems(stationIds),
  ])

  const systemIds = new Set<number>(
    chain((l: LocationRef) => {
      const structure = structureById.get(l.id)
      return [
        l.type === 'solar_system' ? Number(l.id) : null,
        structure?.system_id != null ? Number(structure.system_id) : null,
        // NPC stations aren't in corp_structure/universe_structure; their system
        // comes from the station lookup above.
        l.type === 'station' ? (stationSystems[Number(l.id)] ?? null) : null,
      ].filter((id): id is number => id != null)
    }, locations)
  )
  const systemNames = await fetchSystemNames(systemIds, supabase)

  const nameFor = (loc: LocationRef): string => {
    const structure = structureById.get(loc.id)
    if (structure) return structure.name ?? `Structure #${loc.id}`
    if (loc.type === 'station') return stationNames[Number(loc.id)] ?? `Station #${loc.id}`
    if (loc.type === 'solar_system') return systemNames[Number(loc.id)] ?? `System #${loc.id}`
    return `Location #${loc.id}`
  }

  const systemIdFor = (loc: LocationRef): number | undefined => {
    const structure = structureById.get(loc.id)
    if (structure?.system_id != null) return Number(structure.system_id)
    if (loc.type === 'solar_system') return Number(loc.id)
    if (loc.type === 'station') return stationSystems[Number(loc.id)] ?? undefined
    return undefined
  }

  const systemFor = (loc: LocationRef): string | undefined => {
    const systemId = systemIdFor(loc)
    if (systemId == null) return undefined
    return systemNames[systemId] ?? `#${systemId}`
  }

  return { nameFor, systemFor, systemIdFor }
}
