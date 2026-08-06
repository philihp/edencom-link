// Unit coverage for the pure den-reinforcement detection seam
// (docs/discord-bot/04-reinforcement-detection.md). Everything here is the
// logic a live reinforced den can't be arranged to exercise on demand: the
// transition rules, the dedupe source key, and the exact ping format shared
// with src/app/mercenary-dens/copyDiscordPing.tsx.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composeDenPing,
  denNotificationSource,
  isNewlyReinforced,
  planDenNotifications,
  toRoman,
} from '../src/jobs/denReinforcement.js'

const now = new Date('2026-08-06T12:00:00Z')
const future = '2026-08-07T21:27:55Z' // unix 1786138075
const futureUnix = 1786138075
const past = '2026-08-01T00:00:00Z'

test('newly reinforced: first-ever observation already carrying a future timer', () => {
  assert.equal(isNewlyReinforced(null, { reinforcement_end: future }, now), true)
})

test('newly reinforced: previous observation had no timer', () => {
  assert.equal(isNewlyReinforced({ reinforcement_end: null }, { reinforcement_end: future }, now), true)
})

test('newly reinforced: previous timer already in the past', () => {
  assert.equal(isNewlyReinforced({ reinforcement_end: past }, { reinforcement_end: future }, now), true)
})

test('newly reinforced: a changed (moved) timer pings again', () => {
  const moved = '2026-08-08T09:00:00Z'
  assert.equal(isNewlyReinforced({ reinforcement_end: future }, { reinforcement_end: moved }, now), true)
})

test('not newly reinforced: the same timer observed again', () => {
  assert.equal(isNewlyReinforced({ reinforcement_end: future }, { reinforcement_end: future }, now), false)
})

test('not newly reinforced: same instant in a different ISO spelling', () => {
  const spelled = '2026-08-07T21:27:55.000+00:00'
  assert.equal(isNewlyReinforced({ reinforcement_end: spelled }, { reinforcement_end: future }, now), false)
})

test('not newly reinforced: no timer, or a timer already in the past', () => {
  assert.equal(isNewlyReinforced(null, { reinforcement_end: null }, now), false)
  assert.equal(isNewlyReinforced(null, { reinforcement_end: past }, now), false)
})

test('source key is stable and unix-based', () => {
  assert.equal(denNotificationSource(42, future), `mercenary-den:42:${futureUnix}`)
  assert.equal(denNotificationSource(42, '2026-08-07T21:27:55.000Z'), `mercenary-den:42:${futureUnix}`)
})

test('toRoman matches the sdePlanets algorithm', () => {
  assert.equal(toRoman(1), 'I')
  assert.equal(toRoman(4), 'IV')
  assert.equal(toRoman(5), 'V')
  assert.equal(toRoman(9), 'IX')
  assert.equal(toRoman(14), 'XIV')
})

test('ping body matches the copy-button format', () => {
  const { subject, body } = composeDenPing({
    planet: { system_name: 'QQGH-G', celestial_index: 5 },
    planetId: 40099763,
    reinforcementEnd: future,
  })
  assert.equal(subject, 'Mercenary Den Reinforced')
  assert.equal(body, `Friendly Den Reinforced - QQGH-G V at <t:${futureUnix}:s> <t:${futureUnix}:R>`)
})

test('ping body falls back to the raw planet id when the SDE lookup missed', () => {
  const { body } = composeDenPing({ planet: null, planetId: 40099763, reinforcementEnd: future })
  assert.equal(body, `Friendly Den Reinforced - planet 40099763 at <t:${futureUnix}:s> <t:${futureUnix}:R>`)
})

test('plan fans out one row per channel, identical but for the channel id', () => {
  const rows = planDenNotifications({
    userId: 'user-1',
    denId: 42,
    planetId: 40099763,
    planet: { system_name: 'QQGH-G', celestial_index: 5 },
    prevObservation: null,
    newObservation: { reinforcement_end: future },
    channels: [{ id: 'chan-a' }, { id: 'chan-b' }],
    now,
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((r) => r.discord_channel_id),
    ['chan-a', 'chan-b']
  )
  rows.forEach((row) => {
    assert.equal(row.user_id, 'user-1')
    assert.equal(row.transport, 'discord')
    assert.equal(row.source, `mercenary-den:42:${futureUnix}`)
    assert.equal(row.scheduled_at, now.toISOString())
    assert.equal(row.subject, 'Mercenary Den Reinforced')
  })
})

test('plan is empty with no channels or no transition', () => {
  const base = {
    userId: 'user-1',
    denId: 42,
    planetId: 40099763,
    planet: null,
    prevObservation: { reinforcement_end: future },
    newObservation: { reinforcement_end: future },
    now,
  }
  assert.deepEqual(planDenNotifications({ ...base, channels: [{ id: 'chan-a' }] }), [])
  assert.deepEqual(planDenNotifications({ ...base, prevObservation: null, channels: [] }), [])
})
