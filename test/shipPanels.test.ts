// The two list panels beside and below the fitting ring: the slot listing and
// the bays. Both are pure folds over the fit, and both have a rule that only
// shows up on a real ship — identical modules collapse into a stack, and a bay
// the hull has but hasn't filled is still worth drawing.
import assert from 'node:assert/strict'
import test from 'node:test'

import { groupBays, slotSections } from '../src/app/item/[itemId]/panels.ts'
import type { SlotCounts } from '../src/app/item/[itemId]/esf/attributes.ts'
import type { EsfModule } from '../src/app/item/[itemId]/esf/fit.ts'

const counts = (over: Partial<SlotCounts> = {}): SlotCounts => ({
  High: 0,
  Medium: 0,
  Low: 0,
  SubSystem: 0,
  Rig: 0,
  Launcher: 0,
  Turret: 0,
  ...over,
})

const module = (typeId: number, type: EsfModule['slot']['type'], index: number, chargeTypeId?: number): EsfModule => ({
  typeId,
  slot: { type, index },
  ...(chargeTypeId === undefined ? {} : { charge: { typeId: chargeTypeId } }),
})

test('identical modules collapse into one line, counted', () => {
  const sections = slotSections([module(1, 'High', 1), module(1, 'High', 2), module(1, 'High', 3)], counts({ High: 8 }))
  assert.deepEqual(sections[0].groups, [{ typeId: 1, chargeTypeId: null, count: 3 }])
  assert.equal(sections[0].fitted, 3)
  assert.equal(sections[0].total, 8)
})

test('the same module loaded with different ammunition is two lines', () => {
  // Two lines, because they are two things to buy and two damage profiles.
  const sections = slotSections([module(1, 'High', 1, 200), module(1, 'High', 2, 201)], counts({ High: 2 }))
  assert.deepEqual(sections[0].groups, [
    { typeId: 1, chargeTypeId: 200, count: 1 },
    { typeId: 1, chargeTypeId: 201, count: 1 },
  ])
})

test('families the hull does not have are left out, empty ones are not', () => {
  const labels = slotSections([module(1, 'High', 1)], counts({ High: 4, Medium: 3 })).map((s) => s.label)
  // Mid slots exist and are empty: still a heading. Subsystems don't exist at all.
  assert.deepEqual(labels, ['High slots', 'Mid slots'])
})

test('a module in a family the hull is not reported as having still shows', () => {
  // A T3 whose subsystem modifiers we failed to fold in would otherwise drop
  // its subsystems on the floor.
  const sections = slotSections([module(9, 'SubSystem', 1)], counts({ High: 5 }))
  assert.equal(sections.find((section) => section.family === 'SubSystem')?.fitted, 1)
})

const VOLUMES: Record<number, number> = { 100: 0.025, 101: 5, 102: 1000 }
const volumeOf = (typeId: number) => VOLUMES[typeId]

test('bays fill against their own capacity, and count what is in them', () => {
  const bays = groupBays(
    [
      { typeId: 100, flag: 'Cargo', quantity: 8000 },
      { typeId: 101, flag: 'DroneBay', quantity: 15 },
    ],
    volumeOf,
    (attribute) => ({ capacity: 5000, droneCapacity: 375 })[attribute] ?? 0
  )
  assert.deepEqual(
    bays.map((bay) => [bay.label, bay.used, bay.capacity]),
    [
      ['Cargo hold', 200, 5000],
      ['Drone bay', 75, 375],
    ]
  )
})

test('a bay the hull has but has not filled is still drawn', () => {
  const bays = groupBays([], volumeOf, (attribute) => (attribute === 'capacity' ? 5000 : 0))
  assert.deepEqual(
    bays.map((bay) => [bay.label, bay.items.length, bay.used]),
    [['Cargo hold', 0, 0]]
  )
})

test('a hold we have no capacity attribute for still lists what is in it', () => {
  // CCP adds holds faster than any table is updated; an unnamed bay full of
  // things beats a ship that appears to be carrying nothing.
  const bays = groupBays([{ typeId: 102, flag: 'QuafeBay', quantity: 2 }], volumeOf, () => 0)
  assert.deepEqual(
    bays.map((bay) => [bay.label, bay.capacity, bay.used]),
    [['Quafe bay', null, 2000]]
  )
})

test('a type with no volume in the mirror leaves the total unstated, not wrong', () => {
  const bays = groupBays([{ typeId: 999, flag: 'Cargo', quantity: 3 }], volumeOf, () => 5000)
  assert.equal(bays[0].used, null)
  assert.equal(bays[0].items.length, 1)
})

test('stacks of one type in a bay are merged', () => {
  const bays = groupBays(
    [
      { typeId: 100, flag: 'Cargo', quantity: 1000 },
      { typeId: 100, flag: 'Cargo', quantity: 2000 },
    ],
    volumeOf,
    () => 5000
  )
  assert.deepEqual(bays[0].items, [{ typeId: 100, quantity: 3000, volume: 0.025 }])
})
