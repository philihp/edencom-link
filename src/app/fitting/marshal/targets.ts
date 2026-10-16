// Server-side loader for the marshal controls' numbers (docs/fitting-marshal.md):
// slot usage per own character, with whether each holds the opt-in write
// scope. Feeds the transfer picker on a fit's page, the unmarshal picker on a
// marshalled fit's page, and the meters on /fitting.
//
// Two clients, on purpose. Registrations and fitting counts come from the
// caller's cookie session — RLS on `registration` returns only their own rows,
// which is the ownership proof. The write scope comes from `token.scope`,
// readable only by the service role (the table's grants stop there so a
// browser can never read its own refresh_token), scoped by hand to the
// registration ids the session just proved — the same shape
// account/registrations/matrixData.ts uses.
import type { SupabaseClient } from '@supabase/supabase-js'

import { createServiceClient } from '@/utils/supabase/service'

import { WRITE_SCOPE } from '../../api/fittings/lib'
import { slotUsage, type OwnCharacter, type SlotUsage } from './slots'

type RegistrationRow = { id: string; character_id: number | string | null; name: string | null }

export const fetchWritableRegistrationIds = async (registrationIds: readonly string[]): Promise<Set<string>> => {
  if (registrationIds.length === 0) return new Set()
  const { data } = await createServiceClient()
    .from('token')
    .select('registration_id')
    .in('registration_id', [...registrationIds])
    .contains('scope', [WRITE_SCOPE])
    .returns<Array<{ registration_id: string }>>()
  return new Set((data ?? []).map((t) => t.registration_id))
}

export const fetchSlotUsage = async (supabase: SupabaseClient): Promise<SlotUsage[]> => {
  const [{ data: regs }, { data: fits }] = await Promise.all([
    supabase
      .from('registration')
      .select('id, character_id, name')
      .not('character_id', 'is', null)
      .order('name', { ascending: true })
      .returns<RegistrationRow[]>(),
    // Every fit the session can see, shared ones included; the fold below
    // counts only rows belonging to an own registration.
    supabase.from('character_fitting').select('registration_id').returns<Array<{ registration_id: string }>>(),
  ])
  const own: OwnCharacter[] = (regs ?? []).flatMap((r) =>
    r.character_id == null ? [] : [{ registrationId: r.id, characterId: String(r.character_id), name: r.name }]
  )
  const ownIds = new Set(own.map((c) => c.registrationId))
  const writable = await fetchWritableRegistrationIds([...ownIds])
  return slotUsage(
    (fits ?? []).filter((f) => ownIds.has(f.registration_id)),
    own,
    writable
  )
}
