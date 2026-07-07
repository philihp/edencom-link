import { characterImplants } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-implants'
const SCOPE = 'esi-clones.read_implants.v1'

// GET /characters/{id}/implants/ → character_implant: the implants currently
// plugged into whichever clone body the character presently occupies. Live
// current-state data, like character-location — a plain upsert rather than
// an SCD reconcile.
export const runCharacterImplants = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, ctx }) => {
    const typeIds = await characterImplants(access_token, characterID)
    const { error } = await sudoSupabase.from('character_implant').upsert(
      {
        character_id,
        type_ids: typeIds ?? [],
        recorded_at: new Date().toISOString(),
      },
      { onConflict: 'character_id' }
    )
    if (error) throw error
    console.log(`[${TAG}] ${ctx}: ${(typeIds ?? []).length} implant(s)`)
  })

cli(import.meta.url, TAG, runCharacterImplants)
