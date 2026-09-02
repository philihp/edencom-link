// The EFT export on the ship viewer (src/app/item/[itemId]/eft.ts): the
// adapter from a hull's asset rows to the fitting record the shared writer
// reads. The notation itself is pinned in fittingEft.test.ts; this covers
// what the adapter decides on its own.
import assert from 'node:assert/strict'
import test from 'node:test'

import { eftTypes, shipEft } from '../src/app/item/[itemId]/eft.ts'
import type { SdeType } from '../src/sdeTypes.ts'

const sdeType = (typeID: number, name: string, categoryID: number): SdeType => ({
  typeID,
  name,
  groupID: 0,
  categoryID,
  groupName: null,
  categoryName: null,
  raceID: null,
  metaGroupID: null,
  volume: null,
})

const types = eftTypes({
  587: sdeType(587, 'Rifter', 6),
  2977: sdeType(2977, '200mm AutoCannon II', 7),
  21896: sdeType(21896, 'Republic Fleet EMP S', 8),
  2488: sdeType(2488, 'Warrior II', 18),
})

test('a named hull becomes the fit title, with its rows in the writer’s blocks', () => {
  const eft = shipEft(
    587,
    'Sir Cuddles',
    [
      { typeId: 2977, flag: 'HiSlot0', quantity: 1 },
      { typeId: 21896, flag: 'HiSlot0', quantity: '100' },
      { typeId: 2488, flag: 'DroneBay', quantity: 2 },
    ],
    types
  )

  assert.equal(
    eft,
    ['[Rifter, Sir Cuddles]', '', '200mm AutoCannon II, Republic Fleet EMP S', '', 'Warrior II x2'].join('\n')
  )
})

test('an unnamed hull is titled by its type', () => {
  assert.equal(shipEft(587, null, [], types), '[Rifter, Rifter]')
})

test('a row with no flag has no block to go in and is dropped', () => {
  const eft = shipEft(
    587,
    null,
    [
      { typeId: 2488, flag: null, quantity: 5 },
      { typeId: 2977, flag: 'HiSlot0', quantity: null },
    ],
    types
  )

  // A null quantity counts as one, as a singleton module reports.
  assert.equal(eft, ['[Rifter, Rifter]', '', '200mm AutoCannon II'].join('\n'))
})

test('eftTypes keeps only the name and the category', () => {
  assert.deepEqual(eftTypes({ 587: sdeType(587, 'Rifter', 6) }), { 587: { name: 'Rifter', categoryID: 6 } })
})
