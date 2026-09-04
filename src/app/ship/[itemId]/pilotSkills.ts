import type { SupabaseClient } from '@supabase/supabase-js'
import { reduce } from 'ramda'

import type { Skills } from './esf/dogma'

// The pilot's own trained skills, for calculating a fit against what the
// character can actually fly rather than the all-V baseline every fitting tool
// opens with (stage 5 of docs/custom-fit-ui.md).
//
// **Only injected skills are named.** That is not a shortcut: it is exactly
// what `character_skill` holds (ESI's `/characters/{id}/skills/` reports the
// skills a pilot has injected and nothing else), and exactly what eveship.fit
// itself feeds this engine for a logged-in character — its ESI import is
// `for (const s of skills) map[s.skill_id] = s.active_skill_level`. Matching it
// row for row is what keeps our numbers comparable with theirs. An uninjected
// skill therefore falls to the engine's default for a skill it was not told
// about, which is also why the all-V baseline has to name every skill
// explicitly (see `allSkillsAtLevel`).
export type PilotSkills = {
  // Whose levels these are, for the line that says which basis is in use.
  name: string
  // Skill type id → level, as the engine's `Skills` map.
  levels: Skills
}

type SkillRow = { skill_id: number | string; active_skill_level: number | string | null }

// **Active**, not trained: a pilot who has lost skill points — or dropped to
// Alpha — flies at the active level, and this readout answers "what does this
// hull do for me right now". It is the same column the job-slot bubbles read.
//
// Object accumulator, mutated rather than re-spread: a full skill sheet is
// several hundred rows, and spreading per row would make this quadratic (the
// accepted exception in CLAUDE.md's ramda rule).
export const toSkillLevels = (rows: SkillRow[]): Skills =>
  reduce<SkillRow, Skills>(
    (levels, row) => {
      // A row with no level says nothing, and `Number(null)` is 0 — which
      // would quietly assert "untrained". Leaving the skill unnamed is the
      // honest reading, so the absent cases are rejected before the parse.
      const raw = row.active_skill_level
      if (raw === null || raw === undefined || raw === '') return levels
      const level = Number(raw)
      if (Number.isFinite(level)) levels[String(row.skill_id)] = level
      return levels
    },
    {},
    rows
  )

// The skills of the character holding this hull, or null to fall back to all-V.
//
// **RLS is the access control, and it is the whole story.** The query runs on
// the caller's own client, so rows come back only when the caller holds that
// registration. A ship shared with someone else returns nothing and calculates
// at all-V — a share covers the ship, never the owner's skill sheet. The
// anonymous share path doesn't call this at all: it holds a service-role
// client, which would answer.
//
// Null is also the honest answer when the account never granted
// `esi-skills.read_skills.v1`: no rows, so no claim about the pilot.
// Returns the levels alone; the caller pairs them with whatever it already
// calls the pilot, so this doesn't re-resolve a name the page has in hand.
export const fetchPilotSkills = async (
  supabase: SupabaseClient,
  registrationId: string | null | undefined
): Promise<Skills | null> => {
  if (!registrationId) return null

  const { data } = await supabase
    .from('character_skill')
    .select('skill_id, active_skill_level')
    .eq('registration_id', registrationId)
    .returns<SkillRow[]>()

  return data && data.length > 0 ? toSkillLevels(data) : null
}

// The levels plus the name to say them under — null when either is missing, so
// a caller can hand the viewer its `pilot` prop straight through.
export const pilotSkills = (name: string | null, levels: Skills | null): PilotSkills | null =>
  levels && name ? { name, levels } : null
