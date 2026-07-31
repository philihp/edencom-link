import { wallet } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-wallet'
export const SCOPE = 'esi-wallet.read_character_wallet.v1'

// GET /characters/{id}/wallet/ → character_wallet. Appends one balance row per
// character per run, building the balance-over-time history the character page
// charts. Exported so the combined character-status job (characterStatus.js)
// can reuse this exact per-character pull alongside the other live-state ones.
export const syncCharacterWallet = async ({ access_token, characterID, registration_id, name }) => {
  const balance = await wallet(access_token, characterID)
  const { error } = await sudoSupabase.from('character_wallet').insert({ registration_id, balance })
  if (error) throw error
  console.log(`[${TAG}] ${name} ${registration_id} (${characterID}): ${balance}`)
}

export const runCharacterWallet = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterWallet)

cli(import.meta.url, TAG, runCharacterWallet)
