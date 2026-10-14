// Unit coverage for the container link-preview card's fold: which stacks it
// draws and in what order, and how the chat embed describes the container.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ContainerChild,
  compactCount,
  containerDescription,
  containerStacks,
  itemCountText,
  MAX_STACKS,
} from '../src/app/asset/[locationId]/card/cardModel.ts'
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

// 34 a mineral; 100 a Faction module; 200 a blueprint; 300 unpriced loot.
const TYPES: Record<number, SdeType> = {
  34: type(34, 4),
  100: type(100, 7, 4),
  200: type(200, 9),
  300: type(300, 4),
}

const PRICES: Record<string, number> = { 'Type 34': 5, 'Type 100': 1_000_000, 'Type 200': 50_000_000 }
const unitSell = (name: string) => PRICES[name] ?? null

const child = (typeId: number, quantity = 1, isBlueprintCopy: boolean | null = null): ContainerChild => ({
  typeId,
  quantity,
  isBlueprintCopy,
})

test('stacks one icon per type, summing split stacks', () => {
  const stacks = containerStacks([child(34, 1000), child(34, 500), child(100)], TYPES, unitSell)
  assert.deepEqual(
    stacks.map((s) => [s.typeId, s.count]),
    [
      [100, 1],
      [34, 1500],
    ]
  )
})

test('orders by stack value, then size, with unpriced stacks last', () => {
  const stacks = containerStacks([child(300, 9999), child(34, 10), child(100, 2)], TYPES, unitSell)
  assert.deepEqual(
    stacks.map((s) => s.typeId),
    [100, 34, 300]
  )
})

test('keeps blueprint originals and copies apart, with their own artwork', () => {
  const stacks = containerStacks([child(200, 1, false), child(200, 1, true), child(200, 1, true)], TYPES, unitSell)
  assert.deepEqual(
    stacks.map((s) => [s.variation, s.count]),
    [
      ['bpc', 2],
      ['bp', 1],
    ]
  )
})

test('colours each stack by its quality tier', () => {
  const [faction, mineral] = containerStacks([child(34), child(100)], TYPES, unitSell)
  assert.equal(faction.color, '#3fc16b')
  assert.equal(mineral.color, '#d8dde6')
})

test('cuts the icons at MAX_STACKS', () => {
  const many = Array.from({ length: MAX_STACKS + 5 }, (_, i) => child(1000 + i))
  assert.equal(containerStacks(many, TYPES, unitSell).length, MAX_STACKS)
})

test('compactCount fits a badge', () => {
  assert.equal(compactCount(7), '7')
  assert.equal(compactCount(9999), '9999')
  assert.equal(compactCount(15_000), '15k')
  assert.equal(compactCount(2_345_678), '2.3m')
  assert.equal(compactCount(150_000_000), '150m')
})

test('itemCountText says item or items', () => {
  assert.equal(itemCountText(1), '1 item')
  assert.equal(itemCountText(12), '12 items')
})

test('the embed line names the type, owner, count and value', () => {
  assert.equal(
    containerDescription('Station Warehouse Container', 'Secure Cargo Container', 'Sir Cuddles', 12, {
      sell: 1_230_000_000,
      unpriced: 0,
    }),
    'Station Warehouse Container (Secure Cargo Container), owned by Sir Cuddles. 12 items. Estimated value 1.23b ISK.'
  )
})

test('an empty container says so and claims no value', () => {
  assert.equal(
    containerDescription('Station Container', null, 'Private owner', 0, { sell: null, unpriced: 1 }),
    'Station Container, owned by Private owner. Empty.'
  )
})
