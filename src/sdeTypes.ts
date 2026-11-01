// DB-backed lookup over the nightly SDE mirror (the sde_named_type view — unpublished
// types included, since assets hold them — and the published-only sde_search_type RPC — see supabase/migrations/20260716010000_sde_mirror.sql).
// Resolves type names and searches by name without the old build-time JSON.
// By-id lookups are cached per server process for 6h (misses never cached — see
// src/sdeCache.ts); searches hit the RPC uncached (user-action paths, not
// per-row render paths).
//
// Fifth and final loader migrated in the SDE-loaders-to-database cutover
// (docs/sde-db-cutover/01-loader-cutover.md); with this the app no longer reads
// any src/generated/*.json at runtime.
import { bulkLookup, createByIdCache } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

// groupName/categoryName/raceID/metaGroupID/volume ride along from the view
// (raceID and metaGroupID added by migration 20260728120000_sde_type_race_meta,
// volume by 20260804000000_sde_type_volume): race is which empire's ship line a
// hull belongs to, metaGroup its tech/faction tier — both null for the many
// types the SDE doesn't stamp (metaGroupID is absent on plain T1 types) — and
// volume is m³ per unit, the assembled figure for ships and other singletons
// (the SDE carries no packaged volume). The /fitting ship matrix reads race and
// meta; the asset folder table reads group/category names and volume.
export type SdeType = {
  typeID: number
  name: string
  groupID: number
  categoryID: number | null
  groupName: string | null
  categoryName: string | null
  raceID: number | null
  metaGroupID: number | null
  volume: number | null
}

type TypeRow = {
  type_id: number
  name: string
  group_id: number
  category_id: number | null
  group_name: string | null
  category_name: string | null
  race_id: number | null
  meta_group_id: number | null
  volume: number | null
}

const cache = createByIdCache<SdeType>()

const rowToType = (r: TypeRow): SdeType => ({
  typeID: r.type_id,
  name: r.name,
  groupID: r.group_id,
  categoryID: r.category_id,
  groupName: r.group_name,
  categoryName: r.category_name,
  raceID: r.race_id == null ? null : Number(r.race_id),
  metaGroupID: r.meta_group_id == null ? null : Number(r.meta_group_id),
  volume: r.volume == null ? null : Number(r.volume),
})

const TYPE_COLUMNS = 'type_id, name, group_id, category_id, group_name, category_name, race_id, meta_group_id, volume'

export const getSdeTypes = (typeIDs: Iterable<number>): Promise<Record<number, SdeType>> =>
  bulkLookup(cache, typeIDs, async (chunk) => {
    const { data, error } = await sdeSupabase().from('sde_named_type').select(TYPE_COLUMNS).in('type_id', chunk)
    if (error) {
      console.error(`[sdeTypes] lookup failed: ${error.message}`)
      return []
    }
    return (data ?? []).map((r): [number, SdeType] => {
      const t = rowToType(r as TypeRow)
      return [t.typeID, t]
    })
  })

export const getSdeType = async (typeID: number): Promise<SdeType | null> =>
  (await getSdeTypes([typeID]))[typeID] ?? null

export const getSdeTypeNames = async (typeIDs: Iterable<number>): Promise<Record<number, string>> => {
  const types = await getSdeTypes(typeIDs)
  return Object.fromEntries(Object.entries(types).map(([id, t]) => [id, t.name]))
}

// Every published type in the given groups. Uncached (a handful of call sites,
// each a user action), and small by construction — the callers pass specific
// groups, not whole categories. Used to turn a structure "kind" into the hull
// type ids a corp_structure query can filter on in SQL.
export const getSdeTypesInGroups = async (groupIDs: Iterable<number>): Promise<SdeType[]> => {
  const ids = [...groupIDs]
  if (ids.length === 0) return []
  const { data, error } = await sdeSupabase().from('sde_published_type').select(TYPE_COLUMNS).in('group_id', ids)
  if (error) {
    console.error(`[sdeTypes] group lookup failed: ${error.message}`)
    return []
  }
  return (data ?? []).map((r) => rowToType(r as TypeRow))
}

// A type's variation family, through the sde_type_variants RPC (migration
// 20261019070830_sde_type_variants): the Tech I root plus every type naming it
// as variationParentTypeID, whichever member is asked about, each with its
// meta level (dogma attribute 633) and tier name, lowest meta level first.
// Cached per asked-about id like the by-id loaders; an empty family (an unknown
// id, or a mirror not yet ingested) is a miss and never cached.
export type SdeTypeVariant = {
  typeID: number
  name: string
  groupID: number | null
  metaGroupID: number | null
  metaGroupName: string | null
  metaLevel: number
  published: boolean
  isParent: boolean
}

type VariantRow = {
  type_id: number
  name: string
  group_id: number | null
  meta_group_id: number | null
  meta_group_name: string | null
  meta_level: number
  published: boolean
  is_parent: boolean
}

const variantCache = createByIdCache<SdeTypeVariant[]>()

export const getSdeTypeVariants = async (typeID: number): Promise<SdeTypeVariant[]> => {
  const hit = variantCache.get(typeID)
  if (hit) return hit
  const { data, error } = await sdeSupabase().rpc('sde_type_variants', { p_type_id: typeID })
  if (error) {
    console.error(`[sdeTypes] variant lookup failed: ${error.message}`)
    return []
  }
  const family = ((data ?? []) as VariantRow[]).map((r): SdeTypeVariant => ({
    typeID: Number(r.type_id),
    name: r.name,
    groupID: r.group_id == null ? null : Number(r.group_id),
    metaGroupID: r.meta_group_id == null ? null : Number(r.meta_group_id),
    metaGroupName: r.meta_group_name,
    metaLevel: Number(r.meta_level),
    published: r.published,
    isParent: r.is_parent,
  }))
  if (family.length > 0) variantCache.set(typeID, family)
  return family
}

// Search results now carry the category id (from the view's group→category
// join), so callers filtering by category (e.g. exclude blueprints) no longer
// need a per-row getSdeType lookup.
export type SdeSearchResult = { typeID: number; name: string; coverage: number; categoryID: number | null }

type SearchRow = { type_id: number; name: string; category_id: number | null; coverage: number }

const rowToSearchResult = (r: SearchRow): SdeSearchResult => ({
  typeID: r.type_id,
  name: r.name,
  coverage: r.coverage,
  categoryID: r.category_id,
})

// Search via the sde_search_type RPC, which reproduces the old in-memory
// ranking exactly (coverage desc, shorter name, then id). CHANGE from the JSON
// era: results cap at 1000 (PostgREST/RPC max). Every existing "too many
// results" guard triggers far below that, so `.length` still reads correctly.
export const searchSdeTypesAll = async (query: string): Promise<SdeSearchResult[]> => {
  if (query.trim() === '') return []
  const { data, error } = await sdeSupabase().rpc('sde_search_type', { q: query, lim: 1000 })
  if (error) {
    console.error(`[sdeTypes] search failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as SearchRow[]).map(rowToSearchResult)
}

// Same search, capped to `limit` results — what the autocomplete UIs want.
export const searchSdeTypes = async (query: string, limit = 25): Promise<SdeSearchResult[]> => {
  if (query.trim() === '') return []
  const { data, error } = await sdeSupabase().rpc('sde_search_type', { q: query, lim: limit })
  if (error) {
    console.error(`[sdeTypes] search failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as SearchRow[]).map(rowToSearchResult)
}

// The faction a type belongs to (SDE factionID, migration 20261101090428),
// read from sde_published_type: the ship-memory accent keys on it first, then
// on raceID (src/app/ship/memory/accent.ts). Separate from SdeType because
// the by-id loader reads sde_named_type, which does not carry the column, and
// only ships ever ask. Null for the many types the SDE does not stamp.
const factionCache = createByIdCache<{ factionID: number | null }>()

export const getSdeTypeFactions = async (typeIDs: Iterable<number>): Promise<Record<number, number | null>> => {
  const found = await bulkLookup(factionCache, typeIDs, async (chunk) => {
    const { data, error } = await sdeSupabase()
      .from('sde_published_type')
      .select('type_id, faction_id')
      .in('type_id', chunk)
    if (error) {
      console.error(`[sdeTypes] faction lookup failed: ${error.message}`)
      return []
    }
    return (data ?? []).map((r): [number, { factionID: number | null }] => {
      const row = r as { type_id: number; faction_id: number | null }
      return [Number(row.type_id), { factionID: row.faction_id == null ? null : Number(row.faction_id) }]
    })
  })
  return Object.fromEntries(Object.entries(found).map(([id, f]) => [id, f.factionID]))
}

export const getSdeTypeFaction = async (typeID: number): Promise<number | null> =>
  (await getSdeTypeFactions([typeID]))[typeID] ?? null
