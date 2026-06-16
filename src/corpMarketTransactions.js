import { corpTransactions } from './esi.js'
import { sudoSupabase } from './supabase.js'

const WALLET_DIVISIONS = [1, 2, 3, 4, 5, 6, 7]

// Pull market transactions from every wallet division of one corporation and
// store them in corp_market_transaction, tagged with `character_id` — the
// registration whose token scanned them — so RLS only shows each row to that
// character's owner. The market page unions these with the per-character
// market_transaction rows. transaction_id is globally unique in EVE, so the
// upsert dedupes across divisions and re-scans. Each division is isolated: one
// division failing (e.g. a permissions edge) doesn't abort the others.
export const pullCorpMarketTransactions = async ({
  access_token,
  corporation_id,
  character_id,
  ctx,
  corpLabel = corporation_id,
}) => {
  for (const division of WALLET_DIVISIONS) {
    try {
      const txns = await corpTransactions(access_token, corporation_id, division)
      if (!Array.isArray(txns) || txns.length === 0) {
        console.log(`[corp-market] ${ctx}: corp ${corpLabel} div ${division} 0 transactions`)
        continue
      }
      const rows = txns.map((t) => ({
        transaction_id: t.transaction_id,
        character_id,
        corporation_id,
        division,
        date: t.date,
        type_id: t.type_id,
        quantity: t.quantity,
        unit_price: t.unit_price,
        is_buy: t.is_buy,
        client_id: t.client_id,
        location_id: t.location_id,
        journal_ref_id: t.journal_ref_id,
      }))
      const { error } = await sudoSupabase
        .from('corp_market_transaction')
        .upsert(rows, { onConflict: 'transaction_id', ignoreDuplicates: true })
      if (error) throw error
      console.log(`[corp-market] ${ctx}: corp ${corpLabel} div ${division} ${rows.length} transactions`)
    } catch (e) {
      console.error(`[corp-market] ${ctx}: corp ${corpLabel} div ${division} FAILED message=${e?.message}`)
    }
  }
}
