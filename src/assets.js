import { assets, userAgent } from './esi.js'
import SingleSignOn from 'eve-sso'
import { sudoSupabase } from './supabase.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

const ASSETS_SCOPE = 'esi-assets.read_assets.v1'

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, userAgent)

// Keep id lists under PostgREST's URL length limit when filtering with .in().
const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// The tracked attributes that define a version of an item. Two sightings with
// the same signature are the "same" row; any difference opens a new SCD row.
const signature = (a) =>
  JSON.stringify([
    Number(a.type_id),
    a.location_id == null ? null : Number(a.location_id),
    a.location_flag ?? null,
    a.location_type ?? null,
    a.quantity == null ? null : Number(a.quantity),
    a.is_singleton ?? null,
    !!a.is_blueprint_copy,
  ])

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

const fetchAssets = async (access_token, characterID) => {
  const all = []
  const [firstPage, pagesHeader] = await assets(access_token, characterID, 1)
  all.push(...firstPage)
  const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
  for (let page = 2; page <= totalPages; page++) {
    const [more] = await assets(access_token, characterID, page)
    all.push(...more)
  }
  return { all, totalPages }
}

// Reconcile the freshly fetched assets against the character's current (open)
// rows: unchanged items get their last_seen_at extended, changed items have
// their old row closed and a new one inserted, and vanished items are closed.
const reconcile = async (character_id, fetched) => {
  const { data: current, error } = await sudoSupabase
    .schema('hangar')
    .from('asset_over_time')
    .select('id, item_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_blueprint_copy')
    .eq('character_id', character_id)
    .eq('is_current', true)
  if (error) throw error

  const currentByItem = new Map((current ?? []).map((r) => [Number(r.item_id), r]))

  const now = new Date().toISOString()
  const touchIds = [] // unchanged: bump last_seen_at on the open row
  const closeIds = [] // changed or gone: close the old open row
  const inserts = [] // changed or new: open a fresh version

  for (const a of fetched) {
    const cur = currentByItem.get(Number(a.item_id))
    if (cur && signature(cur) === signature(a)) {
      touchIds.push(cur.id)
    } else {
      if (cur) closeIds.push(cur.id)
      // first_seen_at is left to its `default now()` so it marks this version's debut.
      inserts.push({
        item_id: a.item_id,
        character_id,
        type_id: a.type_id,
        location_id: a.location_id ?? null,
        location_flag: a.location_flag ?? null,
        location_type: a.location_type ?? null,
        quantity: a.quantity ?? null,
        is_singleton: a.is_singleton ?? null,
        is_blueprint_copy: !!a.is_blueprint_copy,
        last_seen_at: now,
      })
    }
    currentByItem.delete(Number(a.item_id))
  }
  // Anything still open but not seen this run has left the character's assets.
  for (const cur of currentByItem.values()) closeIds.push(cur.id)

  for (const ids of chunk(touchIds, 200)) {
    const { error: touchErr } = await sudoSupabase
      .schema('hangar')
      .from('asset_over_time')
      .update({ last_seen_at: now })
      .in('id', ids)
    if (touchErr) throw touchErr
  }
  // Close before inserting so the unique-current-per-item index never collides.
  for (const ids of chunk(closeIds, 200)) {
    const { error: closeErr } = await sudoSupabase
      .schema('hangar')
      .from('asset_over_time')
      .update({ is_current: false })
      .in('id', ids)
    if (closeErr) throw closeErr
  }
  for (const rows of chunk(inserts, 1000)) {
    const { error: insertErr } = await sudoSupabase.schema('hangar').from('asset_over_time').insert(rows)
    if (insertErr) throw insertErr
  }

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length }
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

      const { all, totalPages } = await fetchAssets(access_token, characterID)
      const { touched, opened, closed } = await reconcile(tokenRow.character_id, all)

      const dt = Date.now() - t0
      console.log(
        `[assets] ${ctx}: ${all.length} asset(s) across ${totalPages} page(s); ${touched} unchanged, ${opened} opened, ${closed} closed in ${dt}ms`
      )
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[assets] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  }
}

execute()
