import { SupabaseClient } from '@supabase/supabase-js'

import { defaultScopes, optionalScopes, requiredScopes } from './scopes'

// Resolve the set of ESI scopes to request when this user adds a character.
// A player who has never saved preferences gets every scope. Otherwise we
// always include the required scopes and add back whichever optional scopes
// the player left checked.
export const getEnabledScopes = async (supabase: SupabaseClient, userId: string): Promise<string[]> => {
  const { data } = await supabase.from('user_settings').select('enabled_scopes').eq('user_id', userId).maybeSingle()

  if (!data) return defaultScopes

  const saved: string[] = data.enabled_scopes ?? []
  const enabledOptional = optionalScopes.filter((scope) => saved.includes(scope))
  return [...requiredScopes, ...enabledOptional]
}
