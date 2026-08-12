// Name → location id for the `location:`/`locations:` filters. The rest of the
// schema only ever walks the other way (an id off an asset row, resolved to a
// display name by resolveLocations), so this is the one place that searches.
//
// It searches the same three places a location name can come from, in the same
// precedence resolveLocations reads them: our own corp's structures, the
// ESI-resolved structure cache, NPC stations from the SDE mirror, and solar
// systems from the SDE mirror.
//
// SEARCHING IS NOT READING. The structure caches aren't scoped to the caller
// here (in token mode the client is service-role, where RLS can't scope them),
// and that's deliberate: this resolves a name to an ID, which the caller then
// filters their OWN rows by — the resolvers' .in('registration_id', …) leak
// guard is untouched, and a foreign structure's id simply matches nothing.
// Candidate names are never echoed back; an error repeats only what was typed.
import type { SupabaseClient } from '@supabase/supabase-js'

import { searchSdeSystems } from '@/sdeSystems'
import { escapeLike } from '@/utils/escapeLike'
import { sdeSupabase } from '@/utils/supabase/sde'
import type { NamedRef } from './filters'

// Per source. A term matching more than this many places is a term worth
// narrowing, and the cap keeps one filter from becoming an unbounded `in`.
const PER_SOURCE = 200

type StructureRow = { structure_id: number | string; name: string | null }
type StationRow = { station_id: number | string; name: string | null }

const named = (rows: Array<{ id: number | string; name: string | null }>): NamedRef[] =>
  rows.filter((r) => r.name != null).map((r) => ({ id: String(r.id), name: r.name as string }))

export const searchLocationCandidates = async (term: string, supabase: SupabaseClient): Promise<NamedRef[]> => {
  const trimmed = term.trim()
  if (trimmed === '') return []
  const pattern = `%${escapeLike(trimmed)}%`

  const [corpStructures, cachedStructures, stations, systems] = await Promise.all([
    supabase.from('corp_structure').select('structure_id, name').ilike('name', pattern).limit(PER_SOURCE),
    supabase.from('universe_structure').select('structure_id, name').ilike('name', pattern).limit(PER_SOURCE),
    sdeSupabase().from('sde_station').select('station_id, name').ilike('name', pattern).limit(PER_SOURCE),
    searchSdeSystems(trimmed, PER_SOURCE),
  ])

  const candidates = [
    ...named(((corpStructures.data ?? []) as StructureRow[]).map((r) => ({ id: r.structure_id, name: r.name }))),
    ...named(((cachedStructures.data ?? []) as StructureRow[]).map((r) => ({ id: r.structure_id, name: r.name }))),
    ...named(((stations.data ?? []) as StationRow[]).map((r) => ({ id: r.station_id, name: r.name }))),
    ...systems.map((s): NamedRef => ({ id: String(s.systemID), name: s.name })),
  ]

  // One id can turn up twice (a structure in both caches). Map keeps the LAST
  // entry for a key, so reversing first lets corp_structure's name win — the
  // precedence resolveLocations applies when it renders the same location.
  const byId = new Map(candidates.map((c): [string, NamedRef] => [c.id, c]).reverse())
  return [...byId.values()]
}
