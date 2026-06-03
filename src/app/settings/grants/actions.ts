'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { optionalScopes, requiredScopes } from '@/app/character/scopes'
import { sso } from '@/app/character/sso'

export const saveGrants = async (formData: FormData) => {
  const supabase = await createClient()

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user?.id) {
    return 'You are not signed in'
  }

  // Only optional scopes are toggleable; required scopes are always stored.
  const selectedOptional = optionalScopes.filter((scope) => formData.get(scope) === 'on')
  const enabled_scopes = [...requiredScopes, ...selectedOptional]

  const { error: upsertError } = await supabase
    .from('user_settings')
    .upsert({ user_id: user.id, enabled_scopes, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })

  if (upsertError) {
    return upsertError.message
  }

  // Coming from the Add Character flow, send the player on to EVE SSO with exactly
  // the scopes they just chose. Otherwise return them to the settings page.
  if (formData.get('from') === 'characters') {
    redirect(sso.getRedirectUrl('state', enabled_scopes))
  }
  redirect('/account/settings')
}
