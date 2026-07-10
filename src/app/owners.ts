// Server-side lookup of the owners the current user can see data for: their
// linked characters, and the corporations those characters belong to — the
// corp-scoped tables' RLS keys off registration.corporation_id, so those are
// exactly the corps whose assets/jobs the user can read. Corp names come from
// the universe_name cache (kept populated by the universe-names job);
// unresolved ids fall back to a labelled raw id.
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/utils/supabase/server'
import type { Owner, Owners } from './ownerFilter'

export const fetchOwners = async (client?: SupabaseClient): Promise<Owners> => {
  const supabase = client ?? (await createClient())
  const { data: registrations } = await supabase.from('registration').select('id, name, corporation_id')
  const rows = (registrations ?? []) as Array<{ id: string; name: string; corporation_id: number | string | null }>

  const characters: Owner[] = rows.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

  const corpIds = [...new Set(rows.filter((r) => r.corporation_id != null).map((r) => Number(r.corporation_id)))]
  let corpNames: Record<number, string> = {}
  if (corpIds.length > 0) {
    const { data } = await supabase.from('universe_name').select('id, name').in('id', corpIds)
    corpNames = Object.fromEntries(
      ((data ?? []) as Array<{ id: number | string; name: string }>).map((r) => [Number(r.id), r.name])
    )
  }
  const corporations: Owner[] = corpIds
    .map((id) => ({ id: String(id), name: corpNames[id] ?? `Corporation #${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { characters, corporations }
}
