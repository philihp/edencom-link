// A type's dogma attributes, from the mirrored sde_type_dogma table (one row
// per type, `data.dogmaAttributes` as `[{ attributeID, value }]`). The ship
// page reads these through the WASM engine's protobufs in the browser; this
// is the server-side read for the few callers that need one attribute of one
// hull without the engine — ship memory's fuel-bay capacity. Cached per type
// like the other loaders (misses never cached, src/sdeCache.ts).
import { bulkLookup, createByIdCache } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

// dogmaAttributes ids the app reads by name.
export const SPECIAL_FUEL_BAY_CAPACITY = 1549

export type DogmaAttributes = Record<number, number>

type DogmaRow = { _key: number; data: { dogmaAttributes?: Array<{ attributeID: number; value: number }> } | null }

const cache = createByIdCache<DogmaAttributes>()

export const getSdeTypeAttributes = (typeIDs: Iterable<number>): Promise<Record<number, DogmaAttributes>> =>
  bulkLookup(cache, typeIDs, async (chunk) => {
    const { data, error } = await sdeSupabase().from('sde_type_dogma').select('_key, data').in('_key', chunk)
    if (error) {
      console.error(`[sdeDogma] lookup failed: ${error.message}`)
      return []
    }
    return (data ?? []).map((r): [number, DogmaAttributes] => {
      const row = r as DogmaRow
      return [
        Number(row._key),
        Object.fromEntries((row.data?.dogmaAttributes ?? []).map((a) => [Number(a.attributeID), Number(a.value)])),
      ]
    })
  })

// One attribute of one type, or null when the type has no such attribute (or
// the mirror has no row for it).
export const getSdeTypeAttribute = async (typeID: number, attributeID: number): Promise<number | null> =>
  (await getSdeTypeAttributes([typeID]))[typeID]?.[attributeID] ?? null
