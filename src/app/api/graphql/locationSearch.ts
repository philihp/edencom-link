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
import { pickLocation, pickSystem, systemPrefixPattern, tokenize } from './structureMatch'

// Per source. A term matching more than this many places is a term worth
// narrowing, and the cap keeps one filter from becoming an unbounded `in`.
const PER_SOURCE = 200

type StructureRow = { structure_id: number | string; name: string | null }
type StationRow = { station_id: number | string; name: string | null }
type SystemRow = { system_id: number | string; name: string | null }

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

// The fallback the substring search above can't be: "TKD Reactions" is nobody's
// substring, but it is a system prefix and a word out of a structure's name.
// Only reached when the plain search found nothing, so this widens what
// resolves without changing what already did. The rules — and every refusal —
// live in structureMatch.ts; this is the two queries they need.
//
// Same "searching is not reading" caveat as above: it resolves a name to an id
// the caller then filters their OWN rows by.
export const resolveLocationByTokens = async (term: string, supabase: SupabaseClient): Promise<NamedRef | null> => {
  const tokens = tokenize(term)
  if (tokens.length === 0) return null

  const { data: systemRows } = await sdeSupabase()
    .from('sde_kspace_system')
    .select('system_id, name')
    .ilike('name', systemPrefixPattern(tokens[0]))
    .limit(PER_SOURCE)
  const system = pickSystem(
    tokens[0],
    named(((systemRows ?? []) as SystemRow[]).map((r) => ({ id: r.system_id, name: r.name })))
  )
  if (system.kind !== 'match') return null

  const rest = tokens.slice(1)
  if (rest.length === 0) return system.ref

  const systemId = Number(system.ref.id)
  const [corpStructures, cachedStructures, stations] = await Promise.all([
    supabase.from('corp_structure').select('structure_id, name').eq('system_id', systemId).limit(PER_SOURCE),
    supabase.from('universe_structure').select('structure_id, name').eq('system_id', systemId).limit(PER_SOURCE),
    sdeSupabase().from('sde_station').select('station_id, name').eq('system_id', systemId).limit(PER_SOURCE),
  ])
  const inSystem = [
    ...named(((corpStructures.data ?? []) as StructureRow[]).map((r) => ({ id: r.structure_id, name: r.name }))),
    ...named(((cachedStructures.data ?? []) as StructureRow[]).map((r) => ({ id: r.structure_id, name: r.name }))),
    ...named(((stations.data ?? []) as StationRow[]).map((r) => ({ id: r.station_id, name: r.name }))),
  ]
  // Same de-dupe (and same corp-name-wins precedence) as the search above.
  const byId = new Map(inSystem.map((c): [string, NamedRef] => [c.id, c]).reverse())

  return pickLocation(rest, system.ref, [...byId.values()])
}
