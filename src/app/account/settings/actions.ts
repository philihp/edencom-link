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

// Mint a short-lived, single-use Discord link code, redeemed by running
// `/edencom link <code>` in the Discord channel that should receive alerts
// (docs/discord-bot/03-account-linking.md). Old codes aren't revoked — they
// expire on their own within 10 minutes.
export const generateDiscordLinkCode = async (): Promise<{ code?: string; expiresAt?: string; error?: string }> => {
  const supabase = await createClient()

  const { data, error: userError } = await supabase.auth.getUser()
  if (userError || !data?.user) {
    return { error: 'Not signed in' }
  }

  const code = randomBytes(8).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const { error } = await supabase
    .from('discord_link_code')
    .insert({ code, user_id: data.user.id, expires_at: expiresAt })
  if (error) {
    return { error: error.message }
  }

  return { code, expiresAt }
}

// Remove a linked Discord channel. RLS's owner delete policy scopes the row to
// the caller, so a foreign id matches nothing.
export const removeDiscordChannel = async (id: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { error } = await supabase.from('discord_channel').delete().eq('id', id)
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/account/settings')
  return {}
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
