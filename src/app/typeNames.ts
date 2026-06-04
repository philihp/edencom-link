const cache = new Map<number, Promise<string | null>>()

const fetchOne = (typeID: number): Promise<string | null> =>
  // Cap each lookup so one slow/hung request can't stall a caller that awaits the
  // whole batch (e.g. the /api/assets endpoint); on timeout fetch rejects and we
  // fall back to null (the caller shows the raw id).
  fetch(`https://eve-build-calculator.philihp.com/api/type/${typeID}`, { signal: AbortSignal.timeout(5000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((type: { name?: { en?: string } | string } | null) => {
      if (!type) return null
      return typeof type.name === 'string' ? type.name : (type.name?.en ?? null)
    })
    .catch(() => null)

const lookup = (typeID: number): Promise<string | null> => {
  const cached = cache.get(typeID)
  if (cached) return cached
  const promise = fetchOne(typeID)
  cache.set(typeID, promise)
  promise.then((name) => {
    if (name === null) cache.delete(typeID)
  })
  return promise
}

export const fetchTypeNames = async (typeIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = Array.from(new Set([...typeIDs].filter((n) => Number.isFinite(n))))
  const pairs = await Promise.all(ids.map(async (id) => [id, await lookup(id)] as const))
  return Object.fromEntries(pairs.filter(([, name]) => name !== null) as [number, string][])
}
