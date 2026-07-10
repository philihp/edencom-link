// Resolve solar-system names from the locally generated SDE data (see
// src/sdeSystems.ts / src/buildSde.js) — known-space solar systems are static
// (they change only around once a year, at most), so a name lookup is a free
// in-memory hit with no DB round trip or ESI call. Falls back to the
// universe_name DB cache only for ids the SDE dump doesn't recognize; still
// omits anything neither source has, so callers fall back to showing the raw
// id (never read the evesde SDE schema).
import { difference, filter, fromPairs, keys, map, mergeRight, uniq } from 'ramda'
import { createClient } from '@/utils/supabase/server'
import { getSdeSystemNames } from '@/sdeSystems'

const idNamePairs = map((r: { id: number | string; name: string }): [number, string] => [Number(r.id), r.name])

export const fetchSystemNames = async (systemIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = uniq(filter(Number.isFinite, [...systemIDs]))
  if (ids.length === 0) return {}

  const sdeNames = getSdeSystemNames(ids)
  const unresolvedIds = difference(ids, map(Number, keys(sdeNames)))
  if (unresolvedIds.length === 0) return sdeNames

  const supabase = await createClient()
  const { data } = await supabase
    .from('universe_name')
    .select('id, name')
    .eq('category', 'solar_system')
    .in('id', unresolvedIds)
  const dbNames = fromPairs(idNamePairs((data ?? []) as Array<{ id: number | string; name: string }>))
  return mergeRight(dbNames, sdeNames)
}
