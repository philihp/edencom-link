import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { sso } from '@/app/character/sso'

export type TokenRow = {
  id: string
  character_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  scope: string[]
}

const REFRESH_GRACE_MS = 60_000

export const getFreshAccessToken = async (
  supabase: SupabaseClient,
  token: TokenRow,
): Promise<string | null> => {
  const expiresAt = new Date(token.expires_at).getTime()
  if (expiresAt - Date.now() > REFRESH_GRACE_MS) return token.access_token

  try {
    const {
      access_token,
      refresh_token,
      decoded_access_token: { scp = [], iat, exp },
    } = await sso.getAccessToken(token.refresh_token, true)

    await supabase
      .schema('hangar')
      .from('token')
      .update({
        access_token,
        refresh_token,
        issued_at: new Date(iat * 1000).toISOString(),
        expires_at: new Date(exp * 1000).toISOString(),
        scope: [scp].flat(),
      })
      .eq('id', token.id)

    return access_token
  } catch {
    return null
  }
}
