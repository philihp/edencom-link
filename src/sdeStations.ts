// DB-backed lookup over the nightly SDE mirror (the sde_station view — see
// supabase/migrations/20260716010000_sde_mirror.sql). Resolves NPC station
// names and their solar system without an ESI call or the old build-time JSON.
// The view inner-joins the ESI-resolved name table, so a station missing a
// name is simply absent — exactly the old JSON behavior (the build filtered
// out unnamed stations). By-id lookups are cached per server process for 6h
// (misses never cached — see src/sdeCache.ts).
//
// First loader migrated in the SDE-loaders-to-database cutover
// (docs/sde-db-cutover/01-loader-cutover.md); the other four follow the same
// shape in later PRs of that stack.
import { bulkLookup, createByIdCache } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

export type SdeStation = { stationID: number; name: string; systemID: number }

type StationRow = { station_id: number; name: string; system_id: number }

const cache = createByIdCache<SdeStation>()

const rowToStation = (r: StationRow): SdeStation => ({ stationID: r.station_id, name: r.name, systemID: r.system_id })

export const getSdeStations = (stationIDs: Iterable<number>): Promise<Record<number, SdeStation>> =>
  bulkLookup(cache, stationIDs, async (chunk) => {
    const { data, error } = await sdeSupabase()
      .from('sde_station')
      .select('station_id, name, system_id')
      .in('station_id', chunk)
    if (error) {
      console.error(`[sdeStations] lookup failed: ${error.message}`)
      return []
    }
    return (data ?? []).map((r): [number, SdeStation] => {
      const s = rowToStation(r as StationRow)
      return [s.stationID, s]
    })
  })

export const getSdeStation = async (stationID: number): Promise<SdeStation | null> =>
  (await getSdeStations([stationID]))[stationID] ?? null

export const getSdeStationNames = async (stationIDs: Iterable<number>): Promise<Record<number, string>> => {
  const stations = await getSdeStations(stationIDs)
  return Object.fromEntries(Object.entries(stations).map(([id, s]) => [id, s.name]))
}

export const getSdeStationSystems = async (stationIDs: Iterable<number>): Promise<Record<number, number>> => {
  const stations = await getSdeStations(stationIDs)
  return Object.fromEntries(Object.entries(stations).map(([id, s]) => [id, s.systemID]))
}
