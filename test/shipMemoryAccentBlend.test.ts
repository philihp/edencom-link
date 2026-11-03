// The accents a high-slot module acquires from its hulls
// (src/app/ship/memory/accentBlend.ts, docs/ship-memory.md "Acquired
// accents"): attachments read from the module's own version rows, days per
// hull, and the weight min(1, days / 365) per accent, several hulls giving
// several accents. The doc's two acceptance figures are pinned: one hull for
// 100 days is 0.27; two hulls, a year on each, are two accents at 1.0.
import assert from 'node:assert/strict'
import test from 'node:test'

import { voiceOf, type Voice } from '../src/app/ship/memory/accent.ts'
import {
  accentBlend,
  accentWeight,
  type AttachmentVersion,
  attachments,
  hullTenures,
} from '../src/app/ship/memory/accentBlend.ts'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2025-01-01T00:00:00Z').getTime()
const day = (d: number): string => new Date(T0 + d * DAY).toISOString()

const GILA = 1001 // Guristas by faction
const RIFTER = 1002 // Minmatar
const RIFTER_2 = 1003 // another Minmatar hull
const APOC = 1004 // Amarr

const voices: Record<number, Voice> = {
  [GILA]: voiceOf({ factionId: 500010, raceId: 1 }),
  [RIFTER]: voiceOf({ factionId: 500002, raceId: 2 }),
  [RIFTER_2]: voiceOf({ factionId: 500002, raceId: 2 }),
  [APOC]: voiceOf({ factionId: 500003, raceId: 4 }),
}
const voiceOfHull = (id: number): Voice | null => voices[id] ?? null

const v = (over: Partial<AttachmentVersion> = {}): AttachmentVersion => ({
  parentId: GILA,
  flag: 'HiSlot0',
  isCurrent: false,
  validFrom: day(0),
  validUntil: day(10),
  ...over,
})

test('the weight is linear in days and caps at one year', () => {
  assert.equal(accentWeight(0), 0)
  assert.equal(Math.round(accentWeight(100) * 100) / 100, 0.27)
  assert.equal(accentWeight(365), 1)
  assert.equal(accentWeight(900), 1)
  assert.equal(accentWeight(-5), 0)
})

test('consecutive versions in one hull and slot are one attachment; a hangar spell or another slot ends it', () => {
  const list = attachments([
    v({ validFrom: day(0), validUntil: day(10) }),
    v({ validFrom: day(10), validUntil: day(20) }), // a touch of the same row: still one stretch
    v({ parentId: null, flag: 'Hangar', validFrom: day(20), validUntil: day(25) }),
    v({ validFrom: day(25), validUntil: day(30) }), // back on the same hull: a second attachment
    v({ flag: 'HiSlot3', validFrom: day(30), validUntil: day(40), isCurrent: true }), // moved a slot over
  ])
  assert.deepEqual(list, [
    { hullItemId: GILA, slot: 'HiSlot0', from: day(0), until: day(20) },
    { hullItemId: GILA, slot: 'HiSlot0', from: day(25), until: day(30) },
    { hullItemId: GILA, slot: 'HiSlot3', from: day(30), until: null },
  ])
})

test('a version in a container or a cargo hold is not an attachment, though it has a parent', () => {
  assert.deepEqual(attachments([v({ parentId: 555, flag: 'Unlocked' }), v({ parentId: GILA, flag: 'Cargo' })]), [])
})

test('tenure per hull sums every attachment and reads an open one to the last sighting', () => {
  const list = attachments([
    v({ parentId: RIFTER, validFrom: day(0), validUntil: day(10) }),
    v({ parentId: GILA, validFrom: day(10), validUntil: day(40) }),
    v({ parentId: RIFTER, flag: 'HiSlot1', validFrom: day(40), validUntil: day(40), isCurrent: true }),
  ])
  const tenures = hullTenures(list, day(50))
  assert.deepEqual(tenures, [
    { hullItemId: GILA, attachments: 1, days: 30, slots: ['HiSlot0'], current: false },
    { hullItemId: RIFTER, attachments: 2, days: 20, slots: ['HiSlot0', 'HiSlot1'], current: true },
  ])
})

test("one hull for 100 days is 0.27 of that hull's accent", () => {
  const blend = accentBlend(attachments([v({ validFrom: day(0), validUntil: day(100) })]), day(200), voiceOfHull)
  assert.equal(blend.length, 1)
  assert.equal(blend[0].label, voices[GILA].label)
  assert.equal(blend[0].from, 'faction')
  assert.equal(blend[0].days, 100)
  assert.equal(blend[0].weight, 0.27)
  assert.deepEqual(blend[0].hulls, [GILA])
})

test('two hulls, a year on each, are two accents at 1.0, heaviest first', () => {
  const blend = accentBlend(
    attachments([
      v({ parentId: APOC, validFrom: day(0), validUntil: day(365) }),
      v({ parentId: GILA, validFrom: day(365), validUntil: day(730) }),
    ]),
    day(800),
    voiceOfHull
  )
  assert.deepEqual(
    blend.map((b) => [b.label, b.weight]),
    [
      [voices[APOC].label, 1],
      [voices[GILA].label, 1],
    ]
  )
})

test('two hulls of one faction add their days before the cap, and are one accent', () => {
  const blend = accentBlend(
    attachments([
      v({ parentId: RIFTER, validFrom: day(0), validUntil: day(200) }),
      v({ parentId: RIFTER_2, validFrom: day(200), validUntil: day(400) }),
    ]),
    day(400),
    voiceOfHull
  )
  assert.equal(blend.length, 1)
  assert.equal(blend[0].days, 400)
  assert.equal(blend[0].weight, 1)
  assert.deepEqual(blend[0].hulls, [RIFTER, RIFTER_2])
})

test('only high slots teach: a plate in a low slot for a year acquires nothing, and an unknown hull teaches nothing', () => {
  const blend = accentBlend(
    attachments([
      v({ parentId: APOC, flag: 'LoSlot2', validFrom: day(0), validUntil: day(365) }),
      v({ parentId: 9999, flag: 'HiSlot0', validFrom: day(365), validUntil: day(730) }),
    ]),
    day(730),
    voiceOfHull
  )
  assert.deepEqual(blend, [])
})

test('an open attachment counts to the last sighting', () => {
  const blend = accentBlend(
    attachments([v({ validFrom: day(0), validUntil: day(0), isCurrent: true })]),
    day(365),
    voiceOfHull
  )
  assert.equal(blend[0].weight, 1)
})
