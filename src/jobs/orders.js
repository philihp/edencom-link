import { fileURLToPath } from 'node:url'

import { orders } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { refreshAccessToken } from '../tokenRefresh.js'

const ORDERS_SCOPE = 'esi-markets.read_character_orders.v1'

// Pull each character's open market orders into market_order. ESI's open-orders
// endpoint is a full snapshot, so this mirrors it: upsert everything fetched with
// a fresh seen_at, then drop that character's rows left with an older seen_at —
// those orders have filled, expired or been cancelled, so they're no longer open.
//
// Pass `characterIds` to scope the run to specific registrations (e.g. a single
// character fanned out from the Vercel queue); omit it to refresh everyone, as the
// scheduled workflow does. Throws on a fatal lookup failure so callers — the CLI
// wrapper or the queue consumer — can decide how to surface it.
export const runOrders = async ({ characterIds } = {}) => {
  const { data: characters, error: charactersError } = await sudoSupabase.from('registration').select('id, name')
  if (charactersError) {
    console.error(charactersError)
    throw charactersError
  }
  const characterName = new Map((characters ?? []).map((c) => [c.id, c.name]))

  let tokenQuery = sudoSupabase
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [ORDERS_SCOPE])
  if (characterIds) tokenQuery = tokenQuery.in('character_id', characterIds)
  const { data: tokens, error } = await tokenQuery

  if (error) {
    console.error(error)
    throw error
  }

  for (const tokenRow of tokens ?? []) {
    const name = characterName.get(tokenRow.character_id) ?? '?'
    try {
      const { access_token, characterID } = await refreshAccessToken(tokenRow)
      // One timestamp for the whole character so the stale sweep below is exact.
      const seen_at = new Date().toISOString()
      const fetched = await orders(access_token, characterID)

      if (fetched.length > 0) {
        const rows = fetched.map((o) => ({
          order_id: o.order_id,
          character_id: tokenRow.character_id,
          type_id: o.type_id,
          region_id: o.region_id,
          location_id: o.location_id,
          range: o.range,
          // is_buy_order is present (true) only on buy orders; absent means a sell.
          is_buy: o.is_buy_order ?? false,
          is_corporation: o.is_corporation ?? false,
          price: o.price,
          volume_total: o.volume_total,
          volume_remain: o.volume_remain,
          min_volume: o.min_volume ?? null,
          escrow: o.escrow ?? null,
          duration: o.duration,
          issued: o.issued,
          seen_at,
        }))
        const { error: upsertError } = await sudoSupabase.from('market_order').upsert(rows, { onConflict: 'order_id' })
        if (upsertError) throw upsertError
      }

      // Anything for this character not refreshed this run is no longer open.
      const { error: sweepError } = await sudoSupabase
        .from('market_order')
        .delete()
        .eq('character_id', tokenRow.character_id)
        .lt('seen_at', seen_at)
      if (sweepError) throw sweepError

      console.log(`orders ${name} ${tokenRow.character_id} (${characterID}): ${fetched.length} open`)
    } catch (e) {
      console.error(`orders refresh failed for ${name} ${tokenRow.character_id}:`, e)
    }
  }
}

const execute = async () => {
  try {
    await runOrders()
  } catch (e) {
    console.error('[orders] FAILED', e)
    process.exit(1)
  }
}

// Only run as a CLI (npm run orders / the scheduled workflow) when invoked directly.
// When imported by the Next.js queue consumer, the top-level run must not fire.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  execute()
}
