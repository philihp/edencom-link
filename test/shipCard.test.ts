// Unit coverage for the ship link-preview card's fold: which icons land in
// which row, what the value adds up, and how the chat embed describes it.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type CardChild,
  cardDescription,
  cardRows,
  cardValue,
  compactIsk,
  MAX_ICONS,
  metaColor,
} from '../src/app/ship/[itemId]/card/cardModel.ts'
import type { SdeType } from '../src/sdeTypes.ts'

const type = (typeID: number, categoryID: number, metaGroupID: number | null = 1): SdeType => ({
  typeID,
  name: `Type ${typeID}`,
  groupID: 0,
  categoryID,
  groupName: null,
  categoryName: null,
  raceID: null,
  metaGroupID,
  volume: null,
})

// 17738 hull; 100/101 modules (101 is Officer); 200 a charge; 300 a drone;
// 400 a blueprint copy in cargo; 500 loose cargo.
const TYPES: Record<number, SdeType> = {
  17738: type(17738, 6, 4),
  100: type(100, 7),
  101: type(101, 7, 5),
  200: type(200, 8),
  300: type(300, 18),
  400: type(400, 9),
  500: type(500, 4),
}

const child = (typeId: number, flag: string, quantity = 1, isBlueprintCopy = false): CardChild => ({
  typeId,
  flag,
  quantity,
  isBlueprintCopy,
})

const FIT: CardChild[] = [
  child(100, 'HiSlot1'),
  child(200, 'HiSlot1', 40),
  child(101, 'HiSlot0'),
  child(100, 'LoSlot0'),
  child(300, 'DroneBay', 3),
  child(300, 'DroneBay', 2),
  child(400, 'Cargo', 1, true),
  child(500, 'Cargo', 1000),
]

test('cardRows puts one icon per fitted module, in slot order, without charges', () => {
  const [high] = cardRows(FIT, TYPES)
  assert.equal(high.label, 'High')
  assert.deepEqual(
    high.icons.map((icon) => icon.typeId),
    [101, 100]
  )
})

test('cardRows drops empty rows and stacks drones with a count', () => {
  const rows = cardRows(FIT, TYPES)
  assert.deepEqual(
    rows.map((row) => row.label),
    ['High', 'Low', 'Drones']
  )
  assert.deepEqual(rows[2].icons, [{ typeId: 300, count: 5, color: metaColor(1) }])
})

test('cardRows colours each icon by its own quality tier', () => {
  const [high] = cardRows(FIT, TYPES)
  assert.equal(high.icons[0].color, metaColor(5))
  assert.notEqual(metaColor(5), metaColor(1))
})

test('cardRows cuts a long row', () => {
  const guns = Array.from({ length: MAX_ICONS + 3 }, (_, i) => child(100, `HiSlot${i}`))
  assert.equal(cardRows(guns, TYPES)[0].icons.length, MAX_ICONS)
})

test('metaColor falls back to Tech I for an unknown or missing tier', () => {
  assert.equal(metaColor(null), metaColor(1))
  assert.equal(metaColor(999), metaColor(1))
})

test('cardValue sums hull and contents at sell, skipping blueprints', () => {
  const prices = new Map<number, number | null>([
    [17738, 1_000_000_000],
    [100, 10_000_000],
    [101, 500_000_000],
    [200, 100],
    [300, 1_000_000],
    [400, 999_999_999],
    [500, 5],
  ])
  assert.deepEqual(cardValue(17738, FIT, TYPES, prices), {
    sell: 1_000_000_000 + 2 * 10_000_000 + 500_000_000 + 40 * 100 + 5 * 1_000_000 + 1000 * 5,
    unpriced: 0,
  })
})

test('cardValue counts lines with no price and leaves them out', () => {
  const prices = new Map<number, number | null>([
    [17738, 1_000],
    [100, null],
  ])
  const value = cardValue(17738, [child(100, 'HiSlot0'), child(500, 'Cargo')], TYPES, prices)
  assert.deepEqual(value, { sell: 1_000, unpriced: 2 })
})

test('cardValue is null when nothing has a price', () => {
  assert.equal(cardValue(17738, [], TYPES, new Map()).sell, null)
})

test('compactIsk says ISK the way players do', () => {
  assert.equal(compactIsk(1_234_567_890), '1.23b ISK')
  assert.equal(compactIsk(450_000_000), '450m ISK')
  assert.equal(compactIsk(12_500), '12.5k ISK')
  assert.equal(compactIsk(2_500_000_000_000), '2.5t ISK')
  assert.equal(compactIsk(12), '12 ISK')
})

test('cardDescription names the hull, the owner, the slots and the value', () => {
  const rows = cardRows(FIT, TYPES)
  assert.equal(
    cardDescription('Machariel', 'Battleship', 'Sir Cuddles', rows, { sell: 1_500_000_000, unpriced: 0 }),
    'Machariel (Battleship), owned by Sir Cuddles. High 2 · Low 1 · Drones 5. Estimated value 1.5b ISK at Jita sell.'
  )
})

test('cardDescription leaves out a value it does not have', () => {
  assert.equal(cardDescription('Rifter', null, 'Corp', [], { sell: null, unpriced: 1 }), 'Rifter, owned by Corp.')
})
