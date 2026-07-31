import { reduce, splitEvery } from 'ramda'

import { characterSkills } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-skills'
export const SCOPE = 'esi-skills.read_skills.v1'

// GET /characters/{id}/skills/ → character_skill_over_time (SCD type 2).
// Mirrors the character-ship / character-blueprints reconcile: each skill's
// active/trained level is tracked as a versioned history rather than
// overwritten in place, so a completed training opens a new row and closes the
// old one. A skill is never unlearned, so a row is only ever superseded, never
// closed for vanishing. Exported so the combined character-status job
// (characterStatus.js) can reuse this per-character pull.

// The tracked attributes that define a version of a skill row. Two sightings
// with the same signature are the "same" row; a level change opens a new one.
const signature = (s) => JSON.stringify([Number(s.active_skill_level) || 0, Number(s.trained_skill_level) || 0])

// PostgREST caps a single select; page through every open row so a character
// with hundreds of skills doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (registration_id, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('character_skill_over_time')
    .select('id, skill_id, active_skill_level, trained_skill_level')
    .eq('character_id', registration_id)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(registration_id, from + PAGE))]
}

// Reconcile freshly fetched skills against the character's current (open) rows:
// unchanged skills get their valid_until extended, changed ones have their old
// row closed and a new one inserted. Nothing is closed for vanishing — a
// character never loses a skill.
const reconcile = async (registration_id, fetched) => {
  const current = await fetchCurrentRows(registration_id)
  const currentBySkill = new Map(current.map((c) => [Number(c.skill_id), c]))
  const fetchedBySkill = new Map(fetched.map((s) => [Number(s.skill_id), s]))

  const now = new Date().toISOString()

  // Classify each fetched skill against its current row: unchanged (touch),
  // changed (close + insert), or new (insert only). Plain push-mutated
  // accumulator — a character can carry hundreds of skills.
  const { touchIds, closeIds, inserts } = reduce(
    (acc, s) => {
      const cur = currentBySkill.get(Number(s.skill_id))
      if (cur && signature(cur) === signature(s)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        // valid_from is left to its `default now()` so it marks this version's debut.
        acc.inserts.push({
          character_id: registration_id,
          skill_id: s.skill_id,
          active_skill_level: s.active_skill_level ?? 0,
          trained_skill_level: s.trained_skill_level ?? 0,
          valid_until: now,
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    [...fetchedBySkill.values()]
  )

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase.from('character_skill_over_time').update({ valid_until: now }).in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-skill index never collides.
  await forEachSequential(splitEvery(200, closeIds), async (ids) => {
    const { error } = await sudoSupabase.from('character_skill_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('character_skill_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length }
}

export const syncCharacterSkills = async ({ access_token, characterID, registration_id, ctx }) => {
  const { skills } = await characterSkills(access_token, characterID)
  const { touched, opened, closed } = await reconcile(registration_id, skills ?? [])
  console.log(
    `[${TAG}] ${ctx}: ${(skills ?? []).length} skill(s); ${touched} unchanged, ${opened} opened, ${closed} closed`
  )
}

export const runCharacterSkills = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterSkills)

cli(import.meta.url, TAG, runCharacterSkills)
