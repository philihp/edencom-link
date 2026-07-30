import { corpTransactions } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCorporation, forEachSequential } from './lib.js'

const TAG = 'corp-wallet-transactions'
export const SCOPE = 'esi-wallet.read_corporation_wallets.v1'

const WALLET_DIVISIONS = [1, 2, 3, 4, 5, 6, 7]

// GET /corporations/{id}/wallets/{division}/transactions/ → corp_wallet_transaction.
// Pulls market transactions from every wallet division, tagged with
// `registration_id` — the registration whose token scanned them — so RLS only shows
// each row to that character's owner. The market page unions these with the
// per-character character_wallet_transaction rows. transaction_id is globally
// unique in EVE, so the upsert dedupes across divisions and re-scans (first
// scanner wins attribution). Each division is isolated: one division failing
// (e.g. a permissions edge) doesn't abort the others.
export const runCorpWalletTransactions = ({ characterIds } = {}) =>
  forEachCorporation(
    TAG,
    { scope: SCOPE, characterIds },
    async ({ access_token, corporation_id, registration_id, ctx }) => {
      let failures = 0
      await forEachSequential(WALLET_DIVISIONS, async (division) => {
        try {
          const txns = await corpTransactions(access_token, corporation_id, division)
          if (!Array.isArray(txns) || txns.length === 0) {
            console.log(`[${TAG}] ${ctx}: corp ${corporation_id} div ${division} 0 transactions`)
            return
          }
          const rows = txns.map((t) => ({
            transaction_id: t.transaction_id,
            character_id: registration_id,
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
            .from('corp_wallet_transaction')
            .upsert(rows, { onConflict: 'transaction_id', ignoreDuplicates: true })
          if (error) throw error
          console.log(`[${TAG}] ${ctx}: corp ${corporation_id} div ${division} ${rows.length} transactions`)
        } catch (e) {
          failures += 1
          console.error(`[${TAG}] ${ctx}: corp ${corporation_id} div ${division} FAILED message=${e?.message}`)
        }
      })
      // Every division failing means this character can't read the corp's wallet at
      // all — usually it carries the OAuth scope without the in-game role (director,
      // accountant, etc) the endpoint separately requires — rather than one
      // division's isolated problem. Throw so forEachCorporation (src/jobs/lib.js)
      // leaves the corp open for a later, better-privileged character to try instead
      // of marking it "handled" having pulled nothing.
      if (failures === WALLET_DIVISIONS.length) {
        throw new Error(`corp ${corporation_id}: all ${WALLET_DIVISIONS.length} wallet divisions failed`)
      }
    }
  )

cli(import.meta.url, TAG, runCorpWalletTransactions)
