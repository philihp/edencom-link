'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'

// Persist the caller's opt-in to share their deployed mercenary dens with
// corpmates. Upsert keeps any existing user_settings (enabled_scopes, flags,
// api_token) intact. RLS scopes the write to the caller's own row. Returns
// { error } on failure.
export const setShareMercenaryDens = async (shared: boolean): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    return { error: 'Not signed in' }
  }

  const { error } = await supabase
    .from('user_settings')
    .upsert(
      { user_id: user.id, share_mercenary_dens: shared, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/mercenary-dens')
  return {}
}
