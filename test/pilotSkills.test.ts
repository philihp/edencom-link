// The pure half of the ship viewer's real-skills basis
// (src/app/ship/[itemId]/pilotSkills.ts): turning character_skill rows into the
// map the dogma engine takes, and pairing it with a name to say it under.
//
// The shape matters more than it looks. The engine treats a skill it was not
// told about differently from one named at a level, so what this does and does
// not put in the map decides whether the numbers are right.
import { deepEqual, equal } from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pilotSkills, toSkillLevels } from '../src/app/ship/[itemId]/pilotSkills.ts'

describe('toSkillLevels', () => {
  it('keys the active level by skill type id, as strings', () => {
    deepEqual(
      toSkillLevels([
        { skill_id: 3300, active_skill_level: 5 },
        { skill_id: 3301, active_skill_level: 4 },
      ]),
      { '3300': 5, '3301': 4 }
    )
  })

  it('reads bigint ids and levels that arrive as strings', () => {
    // PostgREST hands bigints back as strings; the engine keys on the id and
    // wants a number for the level.
    deepEqual(toSkillLevels([{ skill_id: '3300', active_skill_level: '3' }]), { '3300': 3 })
  })

  it('keeps a level of zero', () => {
    // An injected-but-untrained skill is a real answer — the pilot has the
    // book and no levels — and differs from never having injected it.
    deepEqual(toSkillLevels([{ skill_id: 3300, active_skill_level: 0 }]), { '3300': 0 })
  })

  it('drops a row whose level does not parse rather than calling it zero', () => {
    // Zero would assert "untrained"; leaving the skill unnamed says nothing,
    // which is the honest reading of a null.
    deepEqual(toSkillLevels([{ skill_id: 3300, active_skill_level: null }]), {})
  })

  it('names only the skills it was given', () => {
    // The whole contract: uninjected skills are absent, exactly as ESI reports
    // them and exactly as eveship.fit feeds the same engine.
    const levels = toSkillLevels([{ skill_id: 3300, active_skill_level: 5 }])
    equal(Object.keys(levels).length, 1)
    equal('3301' in levels, false)
  })

  it('is empty for no rows', () => {
    deepEqual(toSkillLevels([]), {})
  })
})

describe('pilotSkills', () => {
  it('pairs levels with the name to quote them under', () => {
    deepEqual(pilotSkills('Sir Cuddles', { '3300': 5 }), { name: 'Sir Cuddles', levels: { '3300': 5 } })
  })

  it('is null without levels, so the viewer falls back to all V', () => {
    equal(pilotSkills('Sir Cuddles', null), null)
  })

  it('is null without a name, since the readout has no basis to state', () => {
    equal(pilotSkills(null, { '3300': 5 }), null)
  })
})
