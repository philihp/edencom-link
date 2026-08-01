import { characterShip } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-ship'
export const SCOPE = 'esi-location.read_ship_type.v1'

// GET /characters/{id}/ship/ → character_ship_over_time (SCD type 2): the
// ship the character is currently in, docked or not. A character can only be
// in one ship at a time, but which ship changes over a character's life, so
// this tracks history the same way character_asset_over_time does, just with
// a single open row per character instead of one per item.
//
// A row's identity is the ship's item_id alone: an assembled (singleton)
// ship keeps its item_id for as long as it stays assembled — repackaging
// destroys it and re-assembling issues a new one — so "same item_id" means
// "same physical ship". Renaming the ship doesn't open a new row; the open
// row's ship_name is updated in place (like the clones job backfilling
// system_id), so the history reads as one stint per ship, not per name.

const fetchCurrentRow = async (registration_id) => {
  const { data, error } = await sudoSupabase
    .from('character_ship_over_time')
    .select('id, ship_item_id, ship_type_id, ship_name')
    .eq('registration_id', registration_id)
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw error
  return data
}

// Reconcile the freshly fetched ship against the character's current (open)
// row: the same ship extends valid_until (refreshing ship_name in place if
// it was renamed); a different ship closes the old row (if any) and opens a
// new one.
const reconcile = async (registration_id, fetchedShip) => {
  const current = await fetchCurrentRow(registration_id)
  const now = new Date().toISOString()

  if (current && Number(current.ship_item_id) === Number(fetchedShip.ship_item_id)) {
    const renamed = (current.ship_name ?? null) !== (fetchedShip.ship_name ?? null)
    const { error } = await sudoSupabase
      .from('character_ship_over_time')
      .update({ valid_until: now, ...(renamed ? { ship_name: fetchedShip.ship_name ?? null } : {}) })
      .eq('id', current.id)
    if (error) throw error
    return false
  }

  if (current) {
    const { error } = await sudoSupabase
      .from('character_ship_over_time')
      .update({ is_current: false })
      .eq('id', current.id)
    if (error) throw error
  }
  const { error } = await sudoSupabase.from('character_ship_over_time').insert({
    registration_id,
    ship_item_id: fetchedShip.ship_item_id,
    ship_type_id: fetchedShip.ship_type_id,
    ship_name: fetchedShip.ship_name ?? null,
    valid_until: now,
  })
  if (error) throw error
  return true
}

// Exported so the combined character-status job (characterStatus.js) can
// reuse this per-character pull.
export const syncCharacterShip = async ({ access_token, characterID, registration_id, ctx }) => {
  const ship = await characterShip(access_token, characterID)
  const changed = await reconcile(registration_id, ship)
  console.log(`[${TAG}] ${ctx}: ship_item_id=${ship.ship_item_id}${changed ? ' (changed)' : ''}`)
}

export const runCharacterShip = ({ registrationIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, registrationIds }, syncCharacterShip)

cli(import.meta.url, TAG, runCharacterShip)
