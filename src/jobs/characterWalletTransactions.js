import { transactions } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-wallet-transactions'
const SCOPE = 'esi-wallet.read_character_wallet.v1'

// GET /characters/{id}/wallet/transactions/ → character_wallet_transaction.
// transaction_id is globally unique in EVE, so the upsert dedupes re-fetches of
// the same recent history.
export const runCharacterWalletTransactions = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, name }) => {
    const txns = await transactions(access_token, characterID)
    if (txns.length > 0) {
      const rows = txns.map((t) => ({
        transaction_id: t.transaction_id,
        character_id,
        date: t.date,
        type_id: t.type_id,
        quantity: t.quantity,
        unit_price: t.unit_price,
        is_buy: t.is_buy,
        is_personal: t.is_personal,
        client_id: t.client_id,
        location_id: t.location_id,
        journal_ref_id: t.journal_ref_id,
      }))
      const { error } = await sudoSupabase
        .from('character_wallet_transaction')
        .upsert(rows, { onConflict: 'transaction_id', ignoreDuplicates: true })
      if (error) throw error
    }
    console.log(`[${TAG}] ${name} ${character_id} (${characterID}): ${txns.length} fetched`)
  })

cli(import.meta.url, TAG, runCharacterWalletTransactions)
