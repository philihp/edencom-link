// Unit coverage for the flat module cell on the GraphQL fitting rows
// (src/app/api/graphql/fittingSummary.ts): slot order, summed stacks, the
// unnamed-type fallback, and the empty fit.
import assert from 'node:assert/strict'
import test from 'node:test'

import { itemCount, moduleLines, moduleSummary } from '../src/app/api/graphql/fittingSummary.ts'

const names: Record<number, string> = {
  2048: 'Damage Control II',
  3244: 'Warp Scrambler II',
  31718: 'Nanite Repair Paste',
}
const nameOf = (id: number) => names[id]

const items = [
  { type_id: 31718, flag: 'Cargo', quantity: 500 },
  { type_id: 2048, flag: 'LoSlot0', quantity: 1 },
  { type_id: 3244, flag: 'MedSlot0', quantity: 1 },
  { type_id: 3244, flag: 'MedSlot1', quantity: 1 },
]

test('moduleSummary reads in slot order with same-type stacks summed', () => {
  assert.equal(moduleSummary(items, nameOf), '2 x Warp Scrambler II, 1 x Damage Control II, 500 x Nanite Repair Paste')
})

test('an unnamed type still shows up, by id', () => {
  assert.equal(moduleSummary([{ type_id: 99999, flag: 'HiSlot0', quantity: 1 }], nameOf), '1 x Type #99999')
})

test('an empty fit summarises to null, not an empty string', () => {
  assert.equal(moduleSummary([], nameOf), null)
  assert.equal(moduleSummary(null, nameOf), null)
})

test('a type fitted in two slot families sorts by the earliest', () => {
  // The same drone type listed under two bays sorts by the first family it
  // appears in, whichever order the items arrived.
  const lines = moduleLines(
    [
      { type_id: 1, flag: 'Cargo', quantity: 5 },
      { type_id: 1, flag: 'DroneBay', quantity: 5 },
    ],
    () => 'Hobgoblin II'
  )
  assert.deepEqual(lines, [{ typeId: 1, name: 'Hobgoblin II', quantity: 10, sortKey: 6 }])
})

test('itemCount counts stacks whole and defaults a missing quantity to one', () => {
  assert.equal(itemCount(items), 503)
  assert.equal(itemCount([{ type_id: 1, flag: 'HiSlot0' } as never]), 1)
  assert.equal(itemCount(null), 0)
})
