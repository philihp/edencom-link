'use server'

import { randomBytes } from 'node:crypto'

import { createClient } from '@/utils/supabase/server'

// Mint (or return the existing) share token for one of the caller's own
// fittings — the secret in a /fitting/[characterId]/[fittingId]?token=… link
// that lets anyone view that fit without logging in. Mirrors
// src/app/ship/[itemId]/actions.ts's createShareToken/revokeShareToken.
// Ownership is proven by the fit being visible through RLS on
// character_fitting; the insert is additionally enforced by
// character_fitting_share's own with-check policy. Returns { token } or
// { error }.
export const createFittingShareToken = async (
  characterId: string,
  fittingId: string
): Promise<{ token?: string; error?: string }> => {
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

  const { data: existing } = await supabase
    .from('character_fitting_share')
    .select('token')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<{ token: string }>()
  if (existing) {
    return { token: existing.token }
  }

  const token = randomBytes(16).toString('hex')
  const { error } = await supabase.from('character_fitting_share').insert({
    token,
    character_id: characterId,
    fitting_id: fittingId,
  })
  if (error) {
    return { error: error.message }
  }
  return { token }
}

// Revoke the caller's share for this fit — the link dies immediately. RLS
// scopes the delete to the caller's own rows.
export const revokeFittingShareToken = async (characterId: string, fittingId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) {
    return { error: 'Not signed in' }
  }

  const { error } = await supabase
    .from('character_fitting_share')
    .delete()
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
  if (error) {
    return { error: error.message }
  }
  return {}
}
