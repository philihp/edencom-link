// Resolve station names from eve-build-calculator, mirroring the system lookup in
// systemNames.ts. Unresolved ids are simply omitted so callers can fall back to
// showing the raw id (never read the evesde SDE).
const cache = new Map<number, Promise<string | null>>()

const fetchOne = (stationID: number): Promise<string | null> =>
  fetch(`https://eve-build-calculator.philihp.com/api/station/${stationID}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((station: { name?: { en?: string } | string } | null) => {
      if (!station) return null
      return typeof station.name === 'string' ? station.name : (station.name?.en ?? null)
    })
    .catch(() => null)

const lookup = (stationID: number): Promise<string | null> => {
  const cached = cache.get(stationID)
  if (cached) return cached
  const promise = fetchOne(stationID)
  cache.set(stationID, promise)
  promise.then((name) => {
    if (name === null) cache.delete(stationID)
  })
  return promise
}

export const fetchStationNames = async (stationIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = Array.from(new Set([...stationIDs].filter((n) => Number.isFinite(n))))
  const pairs = await Promise.all(ids.map(async (id) => [id, await lookup(id)] as const))
  return Object.fromEntries(pairs.filter(([, name]) => name !== null) as [number, string][])
}
