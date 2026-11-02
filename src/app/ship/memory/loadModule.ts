// The loader behind a module's acquired accents (accentBlend.ts): the types
// and names of the hulls a module has been fitted to, from both hangar
// version tables on the caller's bearer client, narrowed to the caller's own
// owners (the views also show shared rows). Any version of a hull will do —
// a hull keeps its type for life, and a dead hull still taught the module
// its accent — so this reads the newest row per hull id rather than the
// current one.
import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchAllRows } from '../../api/mcp/lib'
import type { Owners } from './load'

export type HullIdentity = { typeId: number; name: string | null }

type Row = { item_id: number | string; type_id: number | string; name?: string | null; valid_from: string }

const read = async (
  supabase: SupabaseClient,
  table: 'character_asset_version' | 'corp_asset_version',
  ownerColumn: 'registration_id' | 'corporation_id',
  ids: string[],
  hullIds: number[]
): Promise<Row[]> => {
  if (ids.length === 0 || hullIds.length === 0) return []
  const columns =
    table === 'character_asset_version' ? 'item_id, type_id, name, valid_from' : 'item_id, type_id, valid_from'
  return fetchAllRows<Row>((from, to) =>
    supabase
      .from(table)
      .select(columns)
      .in('item_id', hullIds)
      .in(ownerColumn, ids)
      .order('valid_from')
      .range(from, to)
      .returns<Row[]>()
  )
}

// Hull item id → its type and latest name, for every hull id the caller's
// record holds a version of. A hull the caller never held is absent.
export const loadHullIdentities = async (
  supabase: SupabaseClient,
  owners: Owners,
  hullIds: number[]
): Promise<Map<number, HullIdentity>> => {
  const [characterRows, corpRows] = await Promise.all([
    read(supabase, 'character_asset_version', 'registration_id', owners.registrationIds, hullIds),
    read(supabase, 'corp_asset_version', 'corporation_id', owners.corporationIds, hullIds),
  ])
  // Rows arrive ordered by valid_from per table; the last write per id wins,
  // so the newest version names the hull.
  return [...characterRows, ...corpRows]
    .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime())
    .reduce<Map<number, HullIdentity>>((acc, r) => {
      const id = Number(r.item_id)
      const seen = acc.get(id)
      acc.set(id, { typeId: Number(r.type_id), name: r.name ?? seen?.name ?? null })
      return acc
    }, new Map())
}
