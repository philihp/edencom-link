import { assets, userAgent } from './esi.js'
import SingleSignOn from 'eve-sso'
import { sudoSupabase } from './supabase.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

const ASSETS_SCOPE = 'esi-assets.read_assets.v1'

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, userAgent)

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
    .contains('scope', [ASSETS_SCOPE])

  if (error) {
    console.error('[assets] token lookup failed:', error)
    process.exit(1)
  }

  console.log(`[assets] found ${tokens?.length ?? 0} token(s) with ${ASSETS_SCOPE}`)

  for (const tokenRow of tokens ?? []) {
    const t0 = Date.now()
    const ctx = `character=${tokenRow.character_id} token=${tokenRow.id}`
    try {
      const { access_token, characterID, scope } = await refreshToken(tokenRow)
      if (!scope.includes(ASSETS_SCOPE)) {
        console.error(`[assets] ${ctx}: refreshed token no longer has ${ASSETS_SCOPE}, skipping`)
        continue
      }

      const all = []
      const [firstPage, pagesHeader] = await assets(access_token, characterID, 1)
      all.push(...firstPage)
      const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
      for (let page = 2; page <= totalPages; page++) {
        const [more] = await assets(access_token, characterID, page)
        all.push(...more)
      }

      const now = new Date().toISOString()
      // first_seen_at is intentionally omitted: the column's `default now()` sets
      // it on insert, and leaving it out of the upsert payload means it is never
      // overwritten when an existing item_id conflicts. last_seen_at is sent every
      // run so it always reflects the most recent sighting.
      const rows = all.map((a) => ({
        item_id: a.item_id,
        character_id: tokenRow.character_id,
        type_id: a.type_id,
        location_id: a.location_id ?? null,
        location_flag: a.location_flag ?? null,
        location_type: a.location_type ?? null,
        quantity: a.quantity ?? null,
        is_singleton: a.is_singleton ?? null,
        is_blueprint_copy: !!a.is_blueprint_copy,
        last_seen_at: now,
      }))

      if (rows.length > 0) {
        const { error: upsertErr } = await sudoSupabase
          .schema('hangar')
          .from('asset')
          .upsert(rows, { onConflict: 'item_id' })
        if (upsertErr) throw upsertErr
      }

      const dt = Date.now() - t0
      console.log(`[assets] ${ctx}: ${rows.length} asset(s) across ${totalPages} page(s) in ${dt}ms`)
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[assets] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  }
}

execute()
