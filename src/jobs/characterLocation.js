import { characterLocation } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-location'
export const SCOPE = 'esi-location.read_location.v1'

// GET /characters/{id}/location/ → character_location. Live current-state
// data — ESI only ever reports "where is the character right now" — so this
// is a plain upsert rather than an SCD reconcile. Exported so the combined
// character-status job (characterStatus.js) can reuse this per-character pull.
export const syncCharacterLocation = async ({ access_token, characterID, character_id, ctx }) => {
  const location = await characterLocation(access_token, characterID)
  const { error } = await sudoSupabase.from('character_location').upsert(
    {
      character_id,
      solar_system_id: location.solar_system_id,
      station_id: location.station_id ?? null,
      structure_id: location.structure_id ?? null,
      recorded_at: new Date().toISOString(),
    },
    { onConflict: 'character_id' }
  )
  if (error) throw error
  console.log(`[${TAG}] ${ctx}: solar_system_id=${location.solar_system_id}`)
}

export const runCharacterLocation = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterLocation)

cli(import.meta.url, TAG, runCharacterLocation)
