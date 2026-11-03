// The NPC world around a system, from the nightly SDE mirror: the NPC
// stations in a system with the corporation that owns each, and the named
// NPC characters the SDE places at those stations (CEOs and agents —
// sde_npc_characters, 11,393 rows, 11,344 of them with a locationID). Ship
// memory's "surroundings" reads these so a first memory can root a thin
// backstory in people and places that exist (docs/ship-memory.md "The first
// version"); nothing here is player data.
//
// Reads the raw mirror tables through the public-read anon client, filtering
// on jsonb paths (PostgREST's `data->>solarSystemID=in.(…)`), since no view
// exposes a station's owner or a character's location and the lists are
// short — a system has a handful of stations, a station a handful of named
// people. Uncached: called once per first recall.
import { sdeSupabase } from './utils/supabase/sde'

export type NpcStation = {
  stationID: number
  name: string
  systemID: number
  ownerCorporationID: number | null
}

export type NpcCorporation = {
  corporationID: number
  name: string
  // The SDE's own blurb, English, whole; the caller trims it.
  description: string | null
  factionID: number | null
}

export type NpcCharacter = {
  characterID: number
  name: string
  corporationID: number | null
  stationID: number | null
  ceo: boolean
  agent: boolean
}

type StationRow = { _key: number; data: { solarSystemID?: number; ownerID?: number } }
type NameRow = { station_id: number; name: string }
type CorpRow = {
  _key: number
  data: { name?: { en?: string }; description?: { en?: string }; factionID?: number }
}
type CharacterRow = {
  _key: number
  data: { name?: { en?: string }; corporationID?: number; locationID?: number; ceo?: boolean; agent?: boolean }
}

const asStrings = (ids: Iterable<number>): string[] => [...new Set(ids)].map(String)

// Every NPC station in the systems named, with its owner. Names come from the
// ESI-resolved table the sde_station view joins; a station without one is
// skipped, as the view skips it.
export const getSystemNpcStations = async (systemIDs: Iterable<number>): Promise<NpcStation[]> => {
  const ids = asStrings(systemIDs)
  if (ids.length === 0) return []
  const { data, error } = await sdeSupabase()
    .from('sde_npc_stations')
    .select('_key, data')
    .in('data->>solarSystemID', ids)
  if (error) {
    console.error(`[sdeNpc] station lookup failed: ${error.message}`)
    return []
  }
  const rows = (data ?? []) as StationRow[]
  const { data: names } = await sdeSupabase()
    .from('sde_npc_station_name')
    .select('station_id, name')
    .in(
      'station_id',
      rows.map((r) => r._key)
    )
  const nameOf = new Map(((names ?? []) as NameRow[]).map((n) => [n.station_id, n.name]))
  return rows.flatMap((r) => {
    const name = nameOf.get(r._key)
    if (name == null || r.data.solarSystemID == null) return []
    return [{ stationID: r._key, name, systemID: r.data.solarSystemID, ownerCorporationID: r.data.ownerID ?? null }]
  })
}

export const getNpcCorporations = async (corporationIDs: Iterable<number>): Promise<Record<number, NpcCorporation>> => {
  const ids = [...new Set(corporationIDs)]
  if (ids.length === 0) return {}
  const { data, error } = await sdeSupabase().from('sde_npc_corporations').select('_key, data').in('_key', ids)
  if (error) {
    console.error(`[sdeNpc] corporation lookup failed: ${error.message}`)
    return {}
  }
  return Object.fromEntries(
    ((data ?? []) as CorpRow[]).flatMap((r) => {
      const name = r.data.name?.en
      if (!name) return []
      return [
        [
          r._key,
          {
            corporationID: r._key,
            name,
            description: r.data.description?.en ?? null,
            factionID: r.data.factionID ?? null,
          },
        ],
      ]
    })
  )
}

// The named NPC characters the SDE places at these stations.
export const getNpcCharactersAt = async (stationIDs: Iterable<number>): Promise<NpcCharacter[]> => {
  const ids = asStrings(stationIDs)
  if (ids.length === 0) return []
  const { data, error } = await sdeSupabase()
    .from('sde_npc_characters')
    .select('_key, data')
    .in('data->>locationID', ids)
  if (error) {
    console.error(`[sdeNpc] character lookup failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as CharacterRow[]).flatMap((r) => {
    const name = r.data.name?.en
    if (!name) return []
    return [
      {
        characterID: r._key,
        name,
        corporationID: r.data.corporationID ?? null,
        stationID: r.data.locationID ?? null,
        ceo: r.data.ceo === true,
        agent: r.data.agent === true,
      },
    ]
  })
}
