import { characterShip } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-ship'
export const SCOPE = 'esi-location.read_ship_type.v1'

// GET /characters/{id}/ship/ → character_ship_over_time (SCD type 2): the
// ship the character is currently in, docked or not. A character can only be
// in one ship at a time, but which ship (and its player-given name) changes
// over a character's life, so this tracks history the same way
// character_asset_over_time does, just with a single open row per character
// instead of one per item.

// The tracked attributes that define a version of the character's current
// ship. Any difference — a different ship, or the current one renamed —
// closes the open row and opens a new one, mirroring character_asset_over_time's
// signature.
const signature = (s) => JSON.stringify([Number(s.ship_item_id), Number(s.ship_type_id), s.ship_name ?? null])

const fetchCurrentRow = async (character_id) => {
  const { data, error } = await sudoSupabase
    .from('character_ship_over_time')
    .select('id, ship_item_id, ship_type_id, ship_name')
    .eq('character_id', character_id)
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw error
  return data
}

// Reconcile the freshly fetched ship against the character's current (open)
// row: unchanged extends last_seen_at; a different ship or a rename closes
// the old row (if any) and opens a new one.
const reconcile = async (character_id, fetchedShip) => {
  const current = await fetchCurrentRow(character_id)
  const now = new Date().toISOString()

  if (current && signature(current) === signature(fetchedShip)) {
    const { error } = await sudoSupabase
      .from('character_ship_over_time')
      .update({ last_seen_at: now })
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
    character_id,
    ship_item_id: fetchedShip.ship_item_id,
    ship_type_id: fetchedShip.ship_type_id,
    ship_name: fetchedShip.ship_name ?? null,
    last_seen_at: now,
  })
  if (error) throw error
  return true
}

// Exported so the combined character-status job (characterStatus.js) can
// reuse this per-character pull.
export const syncCharacterShip = async ({ access_token, characterID, character_id, ctx }) => {
  const ship = await characterShip(access_token, characterID)
  const changed = await reconcile(character_id, ship)
  console.log(`[${TAG}] ${ctx}: ship_item_id=${ship.ship_item_id}${changed ? ' (changed)' : ''}`)
}

export const runCharacterShip = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterShip)

cli(import.meta.url, TAG, runCharacterShip)
