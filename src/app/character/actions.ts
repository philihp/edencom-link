'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { ensureSession } from '../account/lib/anonymousSession'

import { sso } from './sso'
import { getEnabledScopes } from './userScopes'

export const register = async (_formData: FormData) => {
  const supabase = await createClient()

  // Adding a character is one of the two moments an account has to exist
  // (docs/open-registration.md): /character/callback attaches the character to
  // whatever Supabase session is present, and EVE SSO is not itself a Supabase
  // identity. So a caller with no session gets an anonymous account here rather
  // than a detour through login — the character they are about to add is what
  // makes it a real account. A caller who already has one keeps it.
  const user = await ensureSession(supabase)
  if (!user) {
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
