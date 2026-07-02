'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { dispatchRefresh } from './dispatchRefresh'
import { sso } from './sso'
import { getEnabledScopes } from './userScopes'

export const register = async (formData: FormData) => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  // A brand new player (no characters yet and no saved grant preferences) is sent
  // to choose what to share before we send them on to EVE SSO.
  const { count } = await supabase.from('registration').select('id', { count: 'exact', head: true })
  const { data: settings } = await supabase.from('user_settings').select('user_id').eq('user_id', user.id).maybeSingle()
  if ((count ?? 0) === 0 && !settings) {
    redirect('/settings/grants?from=characters')
  }

  const scopes = await getEnabledScopes(supabase, user.id)
  redirect(sso.getRedirectUrl('state', scopes))
}

// Run every on-demand ESI extract for just the signed-in player's
// characters, then send them to /character/refresh to watch it.
export const refreshEsi = async () => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  // RLS scopes the registration read to the caller, so we only refresh ids the user owns.
  const { data: characters } = await supabase.from('registration').select('id, name')
  const batchId = await dispatchRefresh(user.id, characters ?? [])

  redirect(`/character/refresh?batch=${batchId}`)
}

// Mark the selected registration as the player's main character, clearing any
// previous main. RLS scopes both writes to the caller's own registrations, so a
// foreign id simply matches nothing.
export const setMainCharacter = async (formData: FormData) => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  const selected = `${formData.get('main') ?? ''}`
  if (!selected) return

  await supabase.from('registration').update({ is_main: false }).eq('user_id', user.id).eq('is_main', true)
  await supabase.from('registration').update({ is_main: true }).eq('id', selected).eq('user_id', user.id)

  revalidatePath('/character')
}
