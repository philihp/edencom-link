'use server'

import { randomBytes } from 'node:crypto'

import { createClient } from '@/utils/supabase/server'

// Mint (or return the existing) share token for one of the caller's own
// ships — the secret in a /ship/[itemId]?token=… link that lets anyone view
// that ship's fit without logging in. Ownership is proven by the item being
// visible through RLS; the insert's user_id is additionally enforced by the
// table's with-check policy. Returns { token } or { error }.
export const createShareToken = async (itemId: string): Promise<{ token?: string; error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) {
    return { error: 'Not signed in' }
  }

  // RLS-visible in either hangar table ⇒ the caller may share it.
  const [{ data: characterItem }, { data: corpItem }] = await Promise.all([
    supabase.from('character_asset').select('item_id').eq('item_id', itemId).maybeSingle(),
    supabase.from('corp_asset').select('item_id').eq('item_id', itemId).maybeSingle(),
  ])
  if (!characterItem && !corpItem) {
    return { error: 'Not your item' }
  }

  const { data: existing } = await supabase
    .from('shared_asset_token')
    .select('token')
    .eq('item_id', itemId)
    .maybeSingle<{ token: string }>()
  if (existing) {
    return { token: existing.token }
  }

  const token = randomBytes(16).toString('hex')
  const { error } = await supabase.from('shared_asset_token').insert({
    token,
    user_id: auth.user.id,
    item_id: Number(itemId),
  })
  if (error) {
    return { error: error.message }
  }
  return { token }
}

// Revoke the caller's share for this item — the link dies immediately. RLS
// scopes the delete to the caller's own rows.
export const revokeShareToken = async (itemId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) {
    return { error: 'Not signed in' }
  }

  const { error } = await supabase.from('shared_asset_token').delete().eq('item_id', itemId)
  if (error) {
    return { error: error.message }
  }
  return {}
}
