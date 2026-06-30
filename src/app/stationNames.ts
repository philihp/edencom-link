// Resolve NPC station names from the local eve_name cache, which the structures
// job keeps populated (via ESI universe/names, category 'station') for every NPC
// station we currently hold assets in. Mirrors the solar-system lookup in
// systemNames.ts. Unresolved ids are simply omitted so callers can fall back to
// showing the raw id (never read the evesde SDE). Player Upwell structures are
// resolved separately from corp_structure/structure.
import { createClient } from '@/utils/supabase/server'

export const fetchStationNames = async (stationIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = Array.from(new Set([...stationIDs].filter((n) => Number.isFinite(n))))
  if (ids.length === 0) return {}
  const supabase = await createClient()
  const { data } = await supabase.from('eve_name').select('id, name').eq('category', 'station').in('id', ids)
  return Object.fromEntries(
    ((data ?? []) as Array<{ id: number | string; name: string }>).map((r) => [Number(r.id), r.name])
  )
}

// universe/names doesn't return a station's solar system, so we don't cache it.
// The NPC station name already embeds the system (e.g. "Podion VIII - Moon 15 -
// …"), so the assets page falls back to that rather than a separate system label.
// Kept as a stub so callers don't have to special-case NPC stations.
export const fetchStationSystems = async (_stationIDs: Iterable<number>): Promise<Record<number, number>> => ({})
