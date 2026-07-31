'use server'

import { randomBytes } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

export const logoff = async () => {
  const supabase = await createClient()

  const { error } = await supabase.auth.signOut({ scope: 'local' })

  if (error) {
    return error?.message
  }

  redirect('/')
}

export const changePassword = async (formData: FormData) => {
  const supabase = await createClient()

  const password = formData.get('password') as string
  const confirm = formData.get('confirm') as string

  if (password !== confirm) {
    return 'Passwords do not match'
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    return error?.message
  }
}

// Mint (or rotate) the user's api_token — the secret the /api/character/assets IMPORTDATA
// endpoint authenticates with. Upsert keeps any existing enabled_scopes intact.
// Returns { token } on success or { error } on failure.
export const generateApiToken = async (): Promise<{ token?: string; error?: string }> => {
  const supabase = await createClient()

  const { data, error: userError } = await supabase.auth.getUser()
  if (userError || !data?.user) {
    return { error: 'Not signed in' }
  }

  const token = randomBytes(24).toString('hex')
  const { error } = await supabase
    .from('user_settings')
    .upsert(
      { user_id: data.user.id, api_token: token, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  if (error) {
    return { error: error.message }
  }

  return { token }
}

// Mark the selected registration as the player's main character, clearing any
// previous main. RLS scopes both writes to the caller's own registrations, so a
// foreign id simply matches nothing. Returns { error } on failure.
export const setMainCharacter = async (id: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    return { error: 'Not signed in' }
  }

  if (!id) return { error: 'No character selected' }

  await supabase.from('registration').update({ is_main: false }).eq('user_id', user.id).eq('is_main', true)
  const { error } = await supabase.from('registration').update({ is_main: true }).eq('id', id).eq('user_id', user.id)
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/account/settings')
  revalidatePath('/character')
  return {}
}
