import { wallet } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-wallet'
const SCOPE = 'esi-wallet.read_character_wallet.v1'

// GET /characters/{id}/wallet/ → character_wallet. Appends one balance row per
// character per run, building the balance-over-time history the character page
// charts.
export const runCharacterWallet = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, name }) => {
    const balance = await wallet(access_token, characterID)
    const { error } = await sudoSupabase.from('character_wallet').insert({ character_id, balance })
    if (error) throw error
    console.log(`[${TAG}] ${name} ${character_id} (${characterID}): ${balance}`)
  })

cli(import.meta.url, TAG, runCharacterWallet)
