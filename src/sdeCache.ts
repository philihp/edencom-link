// Tiny per-process by-id cache shared by the DB-backed SDE loaders. SDE data
// changes at most once per game patch and the nightly sde-mirror refreshes it,
// so caching found rows for 6h keeps hot render paths (type names appear on
// every page) at zero DB round-trips after warm-up. Misses are NEVER cached:
// on a fresh deploy before the first ingest the sde_* tables are empty, and
// caching a null for 6h would keep every name broken long after the ingest
// lands — a miss must re-query on the next call.
import { splitEvery } from 'ramda'

// Exported so the whole-graph caches that can't use createByIdCache (see
// src/sdeJumps.ts) age on the same clock as the by-id ones.
export const TTL_MS = 6 * 60 * 60 * 1000

export type ByIdCache<T> = {
  get: (id: number) => T | null
  set: (id: number, value: T) => void
}

export const createByIdCache = <T>(): ByIdCache<T> => {
  const cache = new Map<number, { value: T; at: number }>()
  return {
    get: (id) => {
      const hit = cache.get(id)
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value
      return null
    },
    set: (id, value) => cache.set(id, { value, at: Date.now() }),
  }
}

// Bulk by-id lookup: serve what the cache already has, then fetch the unknown
// ids in 500-id chunks (PostgREST caps responses at 1000 rows, so 500 keeps
// well clear) and memoize each found row. `fetchMissing` owns its own error
// handling — it should log and return [] on a DB hiccup so a lookup degrades
// to raw-id fallbacks rather than throwing a page into the error boundary.
export const bulkLookup = async <T>(
  cache: ByIdCache<T>,
  ids: Iterable<number>,
  fetchMissing: (chunk: number[]) => Promise<Array<[number, T]>>
): Promise<Record<number, T>> => {
  const result: Record<number, T> = {}
  const missing: number[] = []
  for (const id of new Set(ids)) {
    if (!Number.isFinite(id)) continue
    const hit = cache.get(id)
    if (hit != null) result[id] = hit
    else missing.push(id)
  }
  for (const chunk of splitEvery(500, missing)) {
    for (const [id, value] of await fetchMissing(chunk)) {
      result[id] = value
      cache.set(id, value)
    }
  }
  return result
}
