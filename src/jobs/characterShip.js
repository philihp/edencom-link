import { characterShip } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-ship'
export const SCOPE = 'esi-location.read_ship_type.v1'

// GET /characters/{id}/ship/ → character_ship: the item_id of whichever ship
// the character is currently in, docked or not. Live current-state data, like
// character-location — a plain upsert rather than an SCD reconcile. Exported
// so the combined character-status job (characterStatus.js) can reuse this
// per-character pull.
export const syncCharacterShip = async ({ access_token, characterID, character_id, ctx }) => {
  const ship = await characterShip(access_token, characterID)
  const { error } = await sudoSupabase.from('character_ship').upsert(
    {
      character_id,
      ship_item_id: ship.ship_item_id,
      ship_type_id: ship.ship_type_id,
      ship_name: ship.ship_name ?? null,
      recorded_at: new Date().toISOString(),
    },
    { onConflict: 'character_id' }
  )
  if (error) throw error
  console.log(`[${TAG}] ${ctx}: ship_item_id=${ship.ship_item_id}`)
}

export const runCharacterShip = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterShip)

cli(import.meta.url, TAG, runCharacterShip)
