import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseQuantity,
  targetTotal,
  totalEiv,
  type StockTarget,
} from '../src/app/industry/planner/stock-types/stockTargets.ts'

test('parseQuantity reads a whole number, blank as zero, and refuses the rest', () => {
  assert.equal(parseQuantity('20'), 20)
  assert.equal(parseQuantity(' 7 '), 7)
  assert.equal(parseQuantity(''), 0)
  assert.equal(parseQuantity(null), 0)
  assert.equal(parseQuantity(undefined), 0)
  assert.equal(parseQuantity(0), 0)
  assert.equal(parseQuantity('-1'), null)
  assert.equal(parseQuantity('1.5'), null)
  assert.equal(parseQuantity('abc'), null)
  assert.equal(parseQuantity('1e3'), null)
})

const lines: StockTarget[] = [
  { typeId: 648, backup: 0, home: 20, jita: 100 },
  { typeId: 34, backup: 2000, home: 0, jita: 0 },
  { typeId: 99999, backup: 1, home: 1, jita: 1 },
]

test('targetTotal sums the three places', () => {
  assert.equal(targetTotal(lines[0]), 120)
  assert.equal(targetTotal(lines[2]), 3)
})

test('totalEiv prices every unit at the adjusted price and counts unpriced lines', () => {
  const prices = new Map([
    [648, 1_000_000],
    [34, 4.5],
  ])
  assert.deepEqual(totalEiv(lines, prices), { eiv: 120 * 1_000_000 + 2000 * 4.5, unpriced: 1 })
})

test('totalEiv of nothing is zero', () => {
  assert.deepEqual(totalEiv([], new Map()), { eiv: 0, unpriced: 0 })
})
