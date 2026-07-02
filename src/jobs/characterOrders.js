import { orders } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-orders'
const SCOPE = 'esi-markets.read_character_orders.v1'

// GET /characters/{id}/orders/ → character_order. ESI's open-orders endpoint is
// a full snapshot, so this mirrors it: upsert everything fetched with a fresh
// seen_at, then drop that character's rows left with an older seen_at — those
// orders have filled, expired or been cancelled, so they're no longer open.
export const runCharacterOrders = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, name }) => {
    // One timestamp for the whole character so the stale sweep below is exact.
    const seen_at = new Date().toISOString()
    const fetched = await orders(access_token, characterID)

    if (fetched.length > 0) {
      const rows = fetched.map((o) => ({
        order_id: o.order_id,
        character_id,
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
      const { error } = await sudoSupabase.from('character_order').upsert(rows, { onConflict: 'order_id' })
      if (error) throw error
    }

    // Anything for this character not refreshed this run is no longer open.
    const { error: sweepError } = await sudoSupabase
      .from('character_order')
      .delete()
      .eq('character_id', character_id)
      .lt('seen_at', seen_at)
    if (sweepError) throw sweepError

    console.log(`[${TAG}] ${name} ${character_id} (${characterID}): ${fetched.length} open`)
  })

cli(import.meta.url, TAG, runCharacterOrders)
