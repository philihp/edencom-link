'use server'

import { createClient } from '@/utils/supabase/server'

export type ShareLevel = 'corporation' | 'alliance' | 'public'
export type ShareRow = { id: string; level: ShareLevel }

// Create a share for one of the caller's own fittings, at the given level.
// Ownership is proven by the fit being visible through RLS on
// character_fitting; character_fitting_share's own with-check policy
// additionally enforces the insert is under one of the caller's own
// registrations.
//
// Every level gates on the caller's session at read time (see the widening
// policy on character_fitting_over_time in schema.sql) — corp/alliance on
// live membership, public on merely being signed in — so one row per level is
// enough: repeat clicks find and return the existing row rather than piling
// up duplicates. No token is minted for any level; anonymous share links are
// a future design (the table's token column is a placeholder for it).
export const createFittingShare = async (
  registrationId: string,
  fittingId: string,
  level: ShareLevel
): Promise<{ share?: ShareRow; error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) {
    return { error: 'Not signed in' }
  }

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('registration_id')
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
    .maybeSingle()
  if (!fit) {
    return { error: 'Not your fitting' }
  }

  const { data: existing } = await supabase
    .from('character_fitting_share')
    .select('id, level')
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
    .eq('level', level)
    .maybeSingle<ShareRow>()
  if (existing) return { share: existing }

  const { data: inserted, error } = await supabase
    .from('character_fitting_share')
    .insert({ registration_id: registrationId, fitting_id: fittingId, level })
    .select('id, level')
    .single<ShareRow>()
  if (error) {
    return { error: error.message }
  }
  return { share: inserted }
}

// Revoke one share by id — RLS scopes the delete to the caller's own rows, so
// this is just the row address; the share stops widening visibility on the
// next query.
export const revokeFittingShare = async (shareId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) {
    return { error: 'Not signed in' }
  }

  const { error } = await supabase.from('character_fitting_share').delete().eq('id', shareId)
  if (error) {
    return { error: error.message }
  }
  return {}
}
