import { characterMercenaryDen, characterMercenaryDens } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-mercenary-dens'
export const SCOPE = 'esi-structures.read_character.v1'

// GET /characters/{id}/structures/mercenary-dens (+ per-den detail) →
// character_mercenary_den. The listing is a full snapshot of the character's
// currently-deployed dens, so this mirrors character_order's live reconcile:
// upsert every den fetched with a fresh recorded_at, then delete that
// character's rows left with an older recorded_at — dens that were unanchored,
// destroyed, or transferred away. Each den's evolving status
// (development/anarchy, reinforcement timer, running state) only comes from the
// per-den detail endpoint, so we fetch one detail per den; a character can only
// field a handful, so the extra request per den is cheap.

export const syncCharacterMercenaryDens = async ({ access_token, characterID, character_id, name }) => {
  const { mercenary_dens: listed = [] } = await characterMercenaryDens(access_token, characterID)

  // One timestamp for the whole character so the stale sweep below is exact.
  const recorded_at = new Date().toISOString()

  await forEachSequential(listed, async (den) => {
    const detail = await characterMercenaryDen(access_token, characterID, den.id)
    const row = {
      character_id,
      den_id: den.id,
      planet_id: den.planet_id,
      type_id: detail.type_id ?? null,
      state: detail.state ?? null,
      development_level: detail.evolution?.development?.level ?? null,
      development_amount: detail.evolution?.development?.amount ?? null,
      anarchy_level: detail.evolution?.anarchy?.level ?? null,
      anarchy_amount: detail.evolution?.anarchy?.amount ?? null,
      infomorphs: detail.infomorphs?.amount ?? null,
      reinforcement_end: detail.reinforcement_timer?.end ?? null,
      skyhook_id: detail.skyhook?.id ?? null,
      skyhook_corporation_id: detail.skyhook?.corporation_id ?? null,
      recorded_at,
    }
    const { error } = await sudoSupabase
      .from('character_mercenary_den')
      .upsert(row, { onConflict: 'character_id,den_id' })
    if (error) throw error
  })

  // Any of this character's dens not refreshed this run no longer exist.
  const { error: sweepError } = await sudoSupabase
    .from('character_mercenary_den')
    .delete()
    .eq('character_id', character_id)
    .lt('recorded_at', recorded_at)
  if (sweepError) throw sweepError

  console.log(`[${TAG}] ${name} ${character_id} (${characterID}): ${listed.length} den(s)`)
}

export const runCharacterMercenaryDens = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterMercenaryDens)

cli(import.meta.url, TAG, runCharacterMercenaryDens)
