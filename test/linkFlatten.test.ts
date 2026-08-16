// CSV flattening for Link results (src/app/link/flatten.ts): primary-list
// discovery under the one-top-level-field guarantee, and one-level row
// flattening (dot-pathed nested objects, joined scalar lists).
import assert from 'node:assert/strict'
import test from 'node:test'

import { csvRows, flattenRow, linkRows, primaryRows } from '../src/app/link/flatten.ts'

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

test('linkRows flattens the primary list end to end', () => {
  const data = {
    assets: {
      totalCount: 1,
      rows: [{ typeName: 'Tritanium', quantity: '5', owner: { name: 'A' } }],
    },
  }
  assert.deepEqual(linkRows(data), [{ typeName: 'Tritanium', quantity: '5', 'owner.name': 'A' }])
})

// csvRows is linkRows squared off for toCsv, which reads its header from the
// first row alone. A nullable entity edge is what makes the rows ragged.
test('csvRows gives every row the same columns when an edge is null on some', () => {
  const data = {
    assets: {
      rows: [
        { itemId: '1', location: null },
        { itemId: '2', location: { name: 'Jita IV - Moon 4', systemName: 'Jita' } },
      ],
    },
  }
  const rows = csvRows(data)
  // The bare `location` key the null row flattened to gives way to the columns
  // the other row expanded into — otherwise toCsv's header would be
  // `itemId,location` and row two's real values would never be written.
  assert.deepEqual(Object.keys(rows[0]), ['itemId', 'location.name', 'location.systemName'])
  assert.deepEqual(Object.keys(rows[1]), ['itemId', 'location.name', 'location.systemName'])
  assert.equal(rows[0]['location.name'], null)
  assert.equal(rows[1]['location.name'], 'Jita IV - Moon 4')
})

test('csvRows fills a column absent from an earlier row', () => {
  const rows = csvRows({ marketOrders: [{ orderId: '1' }, { orderId: '2', escrow: 5 }] })
  assert.deepEqual(rows, [
    { orderId: '1', escrow: null },
    { orderId: '2', escrow: 5 },
  ])
})

test('csvRows keeps false rather than nulling it', () => {
  assert.deepEqual(csvRows({ marketOrders: [{ isBuy: false }] }), [{ isBuy: false }])
})

test('csvRows yields nothing when there is no single row list', () => {
  assert.deepEqual(csvRows({ a: [], b: [] }), [])
})
