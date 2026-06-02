// Resolve station details from eve-build-calculator, mirroring the system lookup
// in systemNames.ts. Unresolved ids are simply omitted so callers can fall back
// to showing the raw id (never read the evesde SDE).
type Station = { name: string | null; solarSystemId: number | null }

type StationResponse = {
  name?: { en?: string } | string
  // The calculator exposes the station's solar system so callers can resolve its
  // name via /api/system/{id}; tolerate either casing the API might return.
  solarSystemId?: number
  solarSystemID?: number
}

const cache = new Map<number, Promise<Station | null>>()

const fetchOne = (stationID: number): Promise<Station | null> =>
  fetch(`https://eve-build-calculator.philihp.com/api/station/${stationID}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((station: StationResponse | null) => {
      if (!station) return null
      const name = typeof station.name === 'string' ? station.name : (station.name?.en ?? null)
      const solarSystemId = station.solarSystemId ?? station.solarSystemID ?? null
      return { name, solarSystemId }
    })
    .catch(() => null)

const lookup = (stationID: number): Promise<Station | null> => {
  const cached = cache.get(stationID)
  if (cached) return cached
  const promise = fetchOne(stationID)
  cache.set(stationID, promise)
  promise.then((station) => {
    if (station === null) cache.delete(stationID)
  })
  return promise
}

const resolve = async <T>(stationIDs: Iterable<number>, pick: (s: Station) => T | null): Promise<Record<number, T>> => {
  const ids = Array.from(new Set([...stationIDs].filter((n) => Number.isFinite(n))))
  const pairs = await Promise.all(
    ids.map(async (id) => {
      const station = await lookup(id)
      return [id, station ? pick(station) : null] as const
    }),
  )
  return Object.fromEntries(pairs.filter(([, value]) => value !== null) as [number, T][])
}

export const fetchStationNames = (stationIDs: Iterable<number>): Promise<Record<number, string>> =>
  resolve(stationIDs, (s) => s.name)

// stationID → solarSystemID, for resolving the system an NPC station sits in.
export const fetchStationSystems = (stationIDs: Iterable<number>): Promise<Record<number, number>> =>
  resolve(stationIDs, (s) => s.solarSystemId)
