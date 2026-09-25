// Unit coverage for hull prices: the bISK field a Chancellor types into, and
// how a set price replaces the market's in an appraisal.
import assert from 'node:assert/strict'
import test from 'node:test'

import { formatBisk, parseBisk } from '../src/app/account/settings/chancellor/hull-prices/bisk.ts'
import { applyHullPrices, fromAppraisal, type PricedLine, pricedTotals } from '../src/app/api/appraisal/pricedLines.ts'

test('parseBisk reads billions of ISK', () => {
  assert.equal(parseBisk('42'), 42_000_000_000)
  assert.equal(parseBisk(' 41.5 '), 41_500_000_000)
  assert.equal(parseBisk('128b'), 128_000_000_000)
  assert.equal(parseBisk('1,280 bISK'), 1_280_000_000_000)
})

test('parseBisk reads an empty field as clear, and refuses anything else', () => {
  assert.equal(parseBisk(''), null)
  assert.equal(parseBisk('   '), null)
  assert.equal(parseBisk('-5'), 'invalid')
  assert.equal(parseBisk('lots'), 'invalid')
})

test('formatBisk shows a price the way the field takes it', () => {
  assert.equal(formatBisk(42_000_000_000), '42')
  assert.equal(formatBisk(41_500_000_000), '41.5')
  assert.equal(parseBisk(formatBisk(128_000_000_000)), 128_000_000_000)
})

const LINES = [
  { name: 'Nyx', quantity: 1 },
  { name: 'Fighter', quantity: 12 },
  { name: 'Mystery', quantity: 2 },
]

test('fromAppraisal pairs request lines with the provider answer by position', () => {
  const items = [
    { sellPrice: null, buyPrice: null, error: 'Item not found' },
    { sellPrice: 5_000_000, buyPrice: 4_000_000, error: null },
    { sellPrice: 99, buyPrice: 90, error: 'no orders' },
  ]
  assert.deepEqual(fromAppraisal(LINES, items), [
    { name: 'Nyx', quantity: 1, sell: null, buy: null },
    { name: 'Fighter', quantity: 12, sell: 5_000_000, buy: 4_000_000 },
    { name: 'Mystery', quantity: 2, sell: null, buy: null },
  ])
})

test('a set hull price replaces the market and counts in both totals', () => {
  const priced: PricedLine[] = [
    { name: 'Nyx', quantity: 1, sell: null, buy: null },
    { name: 'Fighter', quantity: 12, sell: 5_000_000, buy: 4_000_000 },
    { name: 'Mystery', quantity: 2, sell: null, buy: null },
  ]
  const totals = pricedTotals(applyHullPrices(priced, new Map([['Nyx', 42_000_000_000]])))
  assert.deepEqual(totals, {
    sell: 42_000_000_000 + 12 * 5_000_000,
    buy: 42_000_000_000 + 12 * 4_000_000,
    unpriced: ['Mystery'],
  })
})

test('a set hull price wins over a market price too', () => {
  const priced: PricedLine[] = [{ name: 'Nyx', quantity: 1, sell: 20_000_000_000, buy: 19_000_000_000 }]
  assert.equal(pricedTotals(applyHullPrices(priced, new Map([['Nyx', 42_000_000_000]]))).sell, 42_000_000_000)
})

test('without set prices the lines stand as they are', () => {
  const priced: PricedLine[] = [{ name: 'Nyx', quantity: 1, sell: null, buy: null }]
  assert.deepEqual(applyHullPrices(priced, new Map()), priced)
})
