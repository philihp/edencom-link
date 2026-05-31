'use server'

import { createClient } from '@/utils/supabase/server'
import { optionalScopes, requiredScopes } from '@/app/character/scopes'

export const saveScopePreferences = async (formData: FormData) => {
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
    .schema('hangar')
    .from('user_settings')
    .upsert({ user_id: user.id, enabled_scopes, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })

  if (upsertError) {
    return upsertError.message
  }
}
