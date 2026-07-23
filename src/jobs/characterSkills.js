import { map } from 'ramda'

import { characterSkills } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-skills'
export const SCOPE = 'esi-skills.read_skills.v1'

// GET /characters/{id}/skills/ → character_skill: one row per trained skill,
// carrying its active and trained level. Live current-state data, like
// character-implants — a plain upsert per skill rather than an SCD reconcile
// (a skill's level only ever climbs, and skills never leave a character, so a
// row never needs sweeping). Exported so the combined character-status job
// (characterStatus.js) can reuse this per-character pull.
export const syncCharacterSkills = async ({ access_token, characterID, character_id, ctx }) => {
  const { skills } = await characterSkills(access_token, characterID)
  const now = new Date().toISOString()
  const rows = map(
    (s) => ({
      character_id,
      skill_id: s.skill_id,
      active_skill_level: s.active_skill_level ?? 0,
      trained_skill_level: s.trained_skill_level ?? 0,
      recorded_at: now,
    }),
    skills ?? []
  )
  if (rows.length === 0) {
    console.log(`[${TAG}] ${ctx}: 0 skills`)
    return
  }
  const { error } = await sudoSupabase.from('character_skill').upsert(rows, { onConflict: 'character_id,skill_id' })
  if (error) throw error
  console.log(`[${TAG}] ${ctx}: ${rows.length} skill(s)`)
}

export const runCharacterSkills = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterSkills)

cli(import.meta.url, TAG, runCharacterSkills)
