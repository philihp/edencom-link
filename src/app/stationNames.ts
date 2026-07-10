// Resolve NPC station names (and their solar system) from the locally
// generated SDE data (see src/sdeStations.ts / src/buildSde.js) — NPC
// stations are static (conquerable outposts were removed from the game years
// ago), so a lookup is a free in-memory hit with no DB round trip. Falls back
// to the universe_name DB cache only for station names the SDE dump doesn't
// recognize; still omits anything neither source has, so callers fall back to
// showing the raw id (never read the evesde SDE schema). Player Upwell
// structures are resolved separately from corp_structure/universe_structure.
import type { SupabaseClient } from '@supabase/supabase-js'
import { difference, filter, fromPairs, keys, map, mergeRight, uniq } from 'ramda'
import { createClient } from '@/utils/supabase/server'
import { getSdeStationNames, getSdeStationSystems } from '@/sdeStations'

const idNamePairs = map((r: { id: number | string; name: string }): [number, string] => [Number(r.id), r.name])

export const fetchStationNames = async (
  stationIDs: Iterable<number>,
  client?: SupabaseClient
): Promise<Record<number, string>> => {
  const ids = uniq(filter(Number.isFinite, [...stationIDs]))
  if (ids.length === 0) return {}

  const sdeNames = getSdeStationNames(ids)
  const unresolvedIds = difference(ids, map(Number, keys(sdeNames)))
  if (unresolvedIds.length === 0) return sdeNames

  const supabase = client ?? (await createClient())
  const { data } = await supabase
    .from('universe_name')
    .select('id, name')
    .eq('category', 'station')
    .in('id', unresolvedIds)
  const dbNames = fromPairs(idNamePairs((data ?? []) as Array<{ id: number | string; name: string }>))
  return mergeRight(dbNames, sdeNames)
}

// The SDE carries each station's solar system directly (universe/names never
// did), so this is a pure in-memory lookup — no DB cache needed.
export const fetchStationSystems = async (stationIDs: Iterable<number>): Promise<Record<number, number>> =>
  getSdeStationSystems(uniq(filter(Number.isFinite, [...stationIDs])))
