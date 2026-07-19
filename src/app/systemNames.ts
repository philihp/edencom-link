// Resolve solar-system names from the nightly-mirrored SDE tables via the
// DB-backed loader (src/sdeSystems.ts) — known-space systems change only around
// once a game patch, so the loader caches them per process. Falls back to the
// universe_name DB cache only for ids the SDE doesn't recognize (e.g. wormhole
// systems); still omits anything neither source has, so callers fall back to
// showing the raw id (never read the evesde SDE schema).
import type { SupabaseClient } from '@supabase/supabase-js'
import { difference, filter, fromPairs, keys, map, mergeRight, uniq } from 'ramda'
import { createClient } from '@/utils/supabase/server'
import { getSdeSystemNames, getSdeSystemPaths } from '@/sdeSystems'

const idNamePairs = map((r: { id: number | string; name: string }): [number, string] => [Number(r.id), r.name])

export const fetchSystemNames = async (
  systemIDs: Iterable<number>,
  client?: SupabaseClient
): Promise<Record<number, string>> => {
  const ids = uniq(filter(Number.isFinite, [...systemIDs]))
  if (ids.length === 0) return {}

  const sdeNames = await getSdeSystemNames(ids)
  const unresolvedIds = difference(ids, map(Number, keys(sdeNames)))
  if (unresolvedIds.length === 0) return sdeNames

  const supabase = client ?? (await createClient())
  const { data } = await supabase
    .from('universe_name')
    .select('id, name')
    .eq('category', 'solar_system')
    .in('id', unresolvedIds)
  const dbNames = fromPairs(idNamePairs((data ?? []) as Array<{ id: number | string; name: string }>))
  return mergeRight(dbNames, sdeNames)
}

// "[region]/[constellation]/[system]" for known-space systems; falls back to
// the bare universe_name for ids the SDE mirror can't place (e.g. wormholes).
export const fetchSystemPaths = async (
  systemIDs: Iterable<number>,
  client?: SupabaseClient
): Promise<Record<number, string>> => {
  const ids = uniq(filter(Number.isFinite, [...systemIDs]))
  if (ids.length === 0) return {}

  const sdePaths = await getSdeSystemPaths(ids)
  const unresolvedIds = difference(ids, map(Number, keys(sdePaths)))
  if (unresolvedIds.length === 0) return sdePaths

  const supabase = client ?? (await createClient())
  const { data } = await supabase
    .from('universe_name')
    .select('id, name')
    .eq('category', 'solar_system')
    .in('id', unresolvedIds)
  const dbNames = fromPairs(idNamePairs((data ?? []) as Array<{ id: number | string; name: string }>))
  return mergeRight(dbNames, sdePaths)
}
