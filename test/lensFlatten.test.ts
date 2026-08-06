// CSV flattening for Lens results (src/app/lens/flatten.ts): primary-list
// discovery under the one-top-level-field guarantee, and one-level row
// flattening (dot-pathed nested objects, joined scalar lists).
import assert from 'node:assert/strict'
import test from 'node:test'

import { flattenRow, lensRows, primaryRows } from '../src/app/lens/flatten.ts'

test('a root list field is the primary list', () => {
  const data = {
    walletBalances: [
      { ownerName: 'A', balance: 1 },
      { ownerName: 'B', balance: 2 },
    ],
  }
  assert.deepEqual(primaryRows(data), data.walletBalances)
})

test('a page object yields its rows list', () => {
  const data = { assets: { totalCount: 2, truncated: false, rows: [{ typeName: 'Tritanium', quantity: '5' }] } }
  assert.deepEqual(primaryRows(data), [{ typeName: 'Tritanium', quantity: '5' }])
})

test('a plain object without rows is a single row', () => {
  const data = { thing: { a: 1, b: 'x' } }
  assert.deepEqual(primaryRows(data), [{ a: 1, b: 'x' }])
})

test('null data and multi-key data yield no rows', () => {
  assert.deepEqual(primaryRows(null), [])
  assert.deepEqual(primaryRows({ a: [], b: [] }), [])
})

test('flattenRow keeps scalars, dot-paths nested objects, joins scalar lists', () => {
  assert.deepEqual(flattenRow({ a: 1, b: { c: 'x', d: 2 }, e: ['p', 'q', null] }), {
    a: 1,
    'b.c': 'x',
    'b.d': 2,
    e: 'p, q, ',
  })
})

test('lists of objects are left for the CSV JSON fallback', () => {
  const flat = flattenRow({ items: [{ typeId: 1 }] })
  assert.deepEqual(flat, { items: [{ typeId: 1 }] })
})

test('lensRows flattens the primary list end to end', () => {
  const data = {
    assets: {
      totalCount: 1,
      rows: [{ typeName: 'Tritanium', quantity: '5', owner: { name: 'A' } }],
    },
  }
  assert.deepEqual(lensRows(data), [{ typeName: 'Tritanium', quantity: '5', 'owner.name': 'A' }])
})
