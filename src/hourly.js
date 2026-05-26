import { userAgent, wallet } from './esi.js'
import SingleSignOn from './sso.js'
import { sudoSupabase } from './supabase.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1'

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, { userAgent })

const refreshToken = async (tokenRow) => {
  const refreshed = await sso.getAccessToken(tokenRow.refresh_token, true)
  const { access_token, refresh_token } = refreshed
  const { sub, scp = [], iat, exp } = refreshed.decoded_access_token
  const characterID = sub.split(':')[2]
  const scope = [scp].flat()
  await sudoSupabase
    .schema('hangar')
    .from('token')
    .update({
      access_token,
      refresh_token,
      issued_at: new Date(iat * 1000).toISOString(),
      expires_at: new Date(exp * 1000).toISOString(),
      scope,
    })
    .eq('id', tokenRow.id)
  return { access_token, characterID, scope }
}

const execute = async () => {
  const { data: tokens, error } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [WALLET_SCOPE])

  if (error) {
    console.error(error)
    process.exit(1)
  }

  for (const tokenRow of tokens ?? []) {
    try {
      const { access_token, characterID } = await refreshToken(tokenRow)
      const balance = await wallet(access_token, characterID)
      const { error: insertError } = await sudoSupabase
        .schema('hangar')
        .from('wallet')
        .insert({ character_id: tokenRow.character_id, balance })
      if (insertError) throw insertError
      console.log(`wallet ${tokenRow.character_id} (${characterID}): ${balance}`)
    } catch (e) {
      console.error(`wallet refresh failed for ${tokenRow.character_id}:`, e)
    }
  }
}

execute()
