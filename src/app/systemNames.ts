// Resolve solar-system names from the local eve_name cache, which the structures
// job keeps populated for every system we hold a structure in (and for systems
// referenced by other resolved-name pulls). Unresolved ids are simply omitted
// so callers can fall back to showing the raw id (never read the evesde SDE).
import { createClient } from '@/utils/supabase/server'

export const fetchSystemNames = async (systemIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = Array.from(new Set([...systemIDs].filter((n) => Number.isFinite(n))))
  if (ids.length === 0) return {}
  const supabase = await createClient()
  const { data } = await supabase
    .from('eve_name')
    .select('id, name')
    .eq('category', 'solar_system')
    .in('id', ids)
  const result: Record<number, string> = {}
  for (const r of (data ?? []) as Array<{ id: number | string; name: string }>) {
    result[Number(r.id)] = r.name
  }
  return result
}
