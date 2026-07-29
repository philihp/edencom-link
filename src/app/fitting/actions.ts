'use server'

import { randomBytes } from 'node:crypto'

import { createClient } from '@/utils/supabase/server'

export type ShareLevel = 'corporation' | 'alliance' | 'public'
export type ShareRow = { id: string; level: ShareLevel; token: string | null }

// Create a share for one of the caller's own fittings, at the given level.
// Ownership is proven by the fit being visible through RLS on
// character_fitting; character_fitting_share's own with-check policy
// additionally enforces the insert is under one of the caller's own
// registrations.
//
// 'corporation'/'alliance' shares gate on live membership at read time (see
// the widening policy on character_fitting_over_time in schema.sql), so one
// row per level is enough — repeat clicks find and return the existing row
// rather than piling up duplicates. 'public' shares are the opposite: each
// call mints a brand new token, since the whole point is handing out several
// independently revocable links.
export const createFittingShare = async (
  characterId: string,
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
    .select('character_id')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle()
  if (!fit) {
    return { error: 'Not your fitting' }
  }

  if (level !== 'public') {
    const { data: existing } = await supabase
      .from('character_fitting_share')
      .select('id, level, token')
      .eq('character_id', characterId)
      .eq('fitting_id', fittingId)
      .eq('level', level)
      .maybeSingle<ShareRow>()
    if (existing) return { share: existing }
  }

  const token = level === 'public' ? randomBytes(16).toString('hex') : null
  const { data: inserted, error } = await supabase
    .from('character_fitting_share')
    .insert({ character_id: characterId, fitting_id: fittingId, level, token })
    .select('id, level, token')
    .single<ShareRow>()
  if (error) {
    return { error: error.message }
  }
  return { share: inserted }
}

// Revoke one share by id — RLS scopes the delete to the caller's own rows, so
// this is just the row address; a public link dies immediately, a
// corp/alliance share stops widening visibility on the next query.
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
