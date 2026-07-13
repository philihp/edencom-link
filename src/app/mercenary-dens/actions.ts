'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// Reconcile which corporations the caller shares ALL their mercenary dens with.
// Sharing writes one character_mercenary_den_share row per den per chosen corp; unsharing
// removes them. character_mercenary_den_share is RLS-free and authenticated has no write
// grant, so writes go through the service role — scoped here to the caller's own
// dens and restricted to corporations the caller actually owns a character in.
// Returns { error } on failure.
export const setSharedCorps = async (corpIds: number[]): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    return { error: 'Not signed in' }
  }

  const service = createServiceClient()

  // The caller's characters and the corps they belong to — they can only share
  // to corporations one of their own characters is in.
  const { data: regs } = await service.from('registration').select('id, corporation_id').eq('user_id', user.id)
  const registrationIds = (regs ?? []).map((r) => r.id)
  if (registrationIds.length === 0) return {}

  const ownCorps = new Set(
    (regs ?? [])
      .map((r) => r.corporation_id)
      .filter((c): c is number => c != null)
      .map(Number)
  )
  const corps = [...new Set(corpIds.map(Number))].filter((c) => ownCorps.has(c))

  // Every den the caller currently owns (current SCD rows).
  const { data: dens } = await service
    .from('character_mercenary_den_over_time')
    .select('character_id, den_id')
    .eq('is_current', true)
    .in('character_id', registrationIds)
  const denRows = (dens ?? []) as Array<{ character_id: string; den_id: number }>

  // Replace this user's shares wholesale: clear their existing rows, then insert
  // the desired (den × chosen corp) set.
  const { error: delError } = await service.from('character_mercenary_den_share').delete().in('character_id', registrationIds)
  if (delError) {
    return { error: delError.message }
  }

  if (corps.length > 0 && denRows.length > 0) {
    const rows = denRows.flatMap((d) =>
      corps.map((corporation_id) => ({ character_id: d.character_id, den_id: d.den_id, corporation_id }))
    )
    const { error: insError } = await service.from('character_mercenary_den_share').insert(rows)
    if (insError) {
      return { error: insError.message }
    }
  }

  revalidatePath('/mercenary-dens')
  return {}
}
