// Resolve solar-system names from the local universe_name cache, which the
// universe-names job keeps populated for every system we hold a structure in
// (and for systems referenced by other resolved-name pulls). Unresolved ids are
// simply omitted so callers can fall back to showing the raw id (never read the
// evesde SDE).
import { filter, fromPairs, map, uniq } from 'ramda'
import { createClient } from '@/utils/supabase/server'

const idNamePairs = map((r: { id: number | string; name: string }): [number, string] => [Number(r.id), r.name])

export const fetchSystemNames = async (systemIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = uniq(filter(Number.isFinite, [...systemIDs]))
  if (ids.length === 0) return {}
  const supabase = await createClient()
  const { data } = await supabase.from('universe_name').select('id, name').eq('category', 'solar_system').in('id', ids)
  return fromPairs(idNamePairs((data ?? []) as Array<{ id: number | string; name: string }>))
}
