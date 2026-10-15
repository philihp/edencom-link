import type { SupabaseClient } from '@supabase/supabase-js'

import { getSdeSystem } from '@/sdeSystems'

import { fetchStationNames, fetchStationSystems } from '../../stationNames'
import { fetchSystemNames } from '../../systemNames'
import type { PlaceKind } from './card/cardModel'

type Structure = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
  type_id: number | string | null
}

// Everything the heading (and a place share's link-preview card) needs when the id is a place rather than an item:
// which structure/station/system it is, and the system it sits in. Resolved the
// same way the index page does — own-corp + foreign player structures, NPC
// stations, and systems all come from the universe_name DB cache.
//
// The four lookups are independent of each other, so they go out together; only
// the system *name* has to wait, since which system to name depends on them.
export const fetchPlace = async (
  supabase: SupabaseClient,
  locationId: string,
  corpScope: number[] | null,
  // The location_type the root items report, when there are any. A location
  // holding items already says what kind of place it is.
  locationType: string | null
) => {
  const numericId = Number(locationId)

  let corpStructureQuery = supabase
    .from('corp_structure')
    .select('structure_id, name, system_id, type_id')
    .eq('structure_id', numericId)
  if (corpScope) corpStructureQuery = corpStructureQuery.in('corporation_id', corpScope)

  const [{ data: corpStructures }, { data: playerStructures }, stationNames, stationSystems, sdeSystemProbe] =
    await Promise.all([
      corpStructureQuery,
      supabase
        .from('universe_structure')
        .select('structure_id, name, system_id, type_id')
        .eq('structure_id', numericId),
      fetchStationNames([numericId]),
      fetchStationSystems([numericId]),
      // A system id resolves in the SDE; a station/structure id doesn't. Only
      // needed when the type is unknown (no root items) — the case that needs
      // disambiguating: a system opened directly with nothing floating in its
      // space. Fired alongside the structure lookups rather than after them (it
      // is a process-cached SDE read, so an unused probe costs nothing) and
      // discarded below if this turns out to be a structure.
      locationType == null && Number.isFinite(numericId) ? getSdeSystem(numericId) : null,
    ])

  const structure = (corpStructures?.[0] ?? playerStructures?.[0] ?? null) as Structure | null
  const sdeSystem = structure ? null : sdeSystemProbe
  const isSolarSystem = !structure && (locationType === 'solar_system' || sdeSystem != null)

  const systemId = isSolarSystem
    ? numericId
    : structure?.system_id != null
      ? Number(structure.system_id)
      : stationSystems[numericId]
  const systemNames = await fetchSystemNames(
    [systemId, isSolarSystem ? numericId : undefined].filter((n): n is number => n != null)
  )

  const heading =
    (structure
      ? (structure.name ?? `Structure #${locationId}`)
      : isSolarSystem
        ? (systemNames[numericId] ?? sdeSystem?.name ?? `System #${locationId}`)
        : stationNames[numericId]) ?? `Location #${locationId}`

  return {
    heading,
    isSolarSystem,
    // A structure's own type (an Astrahus, a Tatara), when a feed recorded one.
    structureTypeId: structure?.type_id != null ? Number(structure.type_id) : null,
    // What the id turned out to be; null when nothing knows it as a place.
    kind: (structure
      ? 'structure'
      : isSolarSystem
        ? 'system'
        : stationNames[numericId]
          ? 'station'
          : null) as PlaceKind | null,
    systemId,
    systemName: systemId != null ? (systemNames[systemId] ?? `#${systemId}`) : undefined,
  }
}
