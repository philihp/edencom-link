import SingleSignOn from 'eve-sso'

import { userAgent } from './esi.js'
import { sudoSupabase } from './supabase.js'

const sso = new SingleSignOn(
  process.env.EVE_CLIENT_ID,
  process.env.EVE_SECRET_KEY,
  process.env.EVE_CALLBACK_URL,
  userAgent
)

export const refreshAccessToken = async (tokenRow) => {
  const refreshed = await sso.getAccessToken(tokenRow.refresh_token, true)
  const { access_token, refresh_token } = refreshed
  const { sub, scp = [], iat, exp } = refreshed.decoded_access_token
  const characterID = sub.split(':')[2]
  const scope = [scp].flat()
  const issued_at = new Date(iat * 1000).toISOString()
  const expires_at = new Date(exp * 1000).toISOString()
  await sudoSupabase
    .from('token')
    .update({ access_token, refresh_token, issued_at, expires_at, scope })
    .eq('id', tokenRow.id)
  return { access_token, characterID, scope, issued_at, expires_at }
}
