'use server'

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

// Run every scheduled ESI extract on demand for just the signed-in player's
// characters, then send them to /characters/refresh to watch it.
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

  redirect(`/characters/refresh?batch=${batchId}`)
}
