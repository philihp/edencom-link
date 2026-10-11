import { map } from 'ramda'

import { characterWalletJournal } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCharacter } from './lib.js'

const TAG = 'character-wallet-journal'
export const SCOPE = 'esi-wallet.read_character_wallet.v1'

// One ESI journal entry → one character_wallet_journal row. The same mapping
// corpWalletJournal.js applies, minus the division.
export const toRow = (registration_id) => (e) => ({
  registration_id,
  entry_id: e.id,
  date: e.date,
  ref_type: e.ref_type,
  amount: e.amount ?? null,
  balance: e.balance ?? null,
  reason: e.reason ?? null,
  description: e.description ?? null,
  first_party_id: e.first_party_id ?? null,
  second_party_id: e.second_party_id ?? null,
  context_id: e.context_id ?? null,
  context_id_type: e.context_id_type ?? null,
  tax: e.tax ?? null,
  tax_receiver_id: e.tax_receiver_id ?? null,
})

// GET /characters/{id}/wallet/journal/ → character_wallet_journal. ESI serves
// the trailing 30 days, paged; entry ids are stable, so the upsert dedupes the
// overlap between runs and the table only ever grows. Paged, so unconditional
// (no ETag — see the conditional-request note in src/esi.js).
export const runCharacterWalletJournal = ({ registrationIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, registrationIds },
    async ({ access_token, characterID, registration_id, name }) => {
      const entries = await fetchAllPages((page) => characterWalletJournal(access_token, characterID, page))
      if (entries.length > 0) {
        const { error } = await sudoSupabase
          .from('character_wallet_journal')
          .upsert(map(toRow(registration_id), entries), {
            onConflict: 'registration_id,entry_id',
            ignoreDuplicates: true,
          })
        if (error) throw error
      }
      console.log(`[${TAG}] ${name} ${registration_id} (${characterID}): ${entries.length} entries`)
    }
  )

cli(import.meta.url, TAG, runCharacterWalletJournal)
