// Resolve solar-system names from eve-build-calculator, mirroring the type
// lookup in typeNames.ts. Unresolved ids are simply omitted so callers can fall
// back to showing the raw id (never read the evesde SDE).
const cache = new Map<number, Promise<string | null>>()

const fetchOne = (systemID: number): Promise<string | null> =>
  fetch(`https://eve-build-calculator.philihp.com/api/system/${systemID}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((system: { name?: { en?: string } | string } | null) => {
      if (!system) return null
      return typeof system.name === 'string' ? system.name : (system.name?.en ?? null)
    })
    .catch(() => null)

const lookup = (systemID: number): Promise<string | null> => {
  const cached = cache.get(systemID)
  if (cached) return cached
  const promise = fetchOne(systemID)
  cache.set(systemID, promise)
  promise.then((name) => {
    if (name === null) cache.delete(systemID)
  })
  return promise
}

export const fetchSystemNames = async (systemIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = Array.from(new Set([...systemIDs].filter((n) => Number.isFinite(n))))
  const pairs = await Promise.all(ids.map(async (id) => [id, await lookup(id)] as const))
  return Object.fromEntries(pairs.filter(([, name]) => name !== null) as [number, string][])
}
