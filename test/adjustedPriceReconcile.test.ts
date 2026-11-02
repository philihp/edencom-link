// The market-adjusted-prices SCD-2 seam (src/jobs/adjustedPriceReconcile.js):
// what a version is, and how a listing is classified against the open rows.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_PLAUSIBLE_TYPES,
  normalizeAdjustedPrices,
  partitionAdjustedPrices,
  signature,
} from '../src/jobs/adjustedPriceReconcile.js'

type PriceRow = { type_id: number; adjusted_price: number; average_price: number | null }
type Partition = { touchIds: number[]; closeIds: number[]; inserts: PriceRow[] }

const partition = (current: PriceRow[] | undefined, fetched: PriceRow[] | undefined): Partition =>
  partitionAdjustedPrices(current, fetched)

test('normalizeAdjustedPrices keeps both prices, rounded to ISK precision', () => {
  assert.deepEqual(normalizeAdjustedPrices([{ type_id: 34, adjusted_price: 4.58321, average_price: 4.6 }]), [
    { type_id: 34, adjusted_price: 4.58, average_price: 4.6 },
  ])
})

test('a type CCP publishes no average for keeps null, not zero', () => {
  const [row] = normalizeAdjustedPrices([{ type_id: 34, adjusted_price: 4.58 }])
  assert.equal(row.average_price, null)
})

test('an entry with no usable type id or adjusted price is dropped', () => {
  assert.deepEqual(
    normalizeAdjustedPrices([{ type_id: null, adjusted_price: 1 }, { type_id: 34 }, { type_id: 'x' }]),
    []
  )
})

test('a duplicate type id keeps the last entry', () => {
  const rows = normalizeAdjustedPrices([
    { type_id: 34, adjusted_price: 1 },
    { type_id: 34, adjusted_price: 2 },
  ])
  assert.deepEqual(rows, [{ type_id: 34, adjusted_price: 2, average_price: null }])
})

test('the signature is both prices and nothing else', () => {
  assert.equal(
    signature({ type_id: 34, adjusted_price: 4.58, average_price: 4.6 }),
    signature({ type_id: 99, adjusted_price: 4.58, average_price: 4.6 })
  )
  assert.notEqual(
    signature({ type_id: 34, adjusted_price: 4.58, average_price: 4.6 }),
    signature({ type_id: 34, adjusted_price: 4.58, average_price: 4.7 })
  )
})

test('an unchanged price is touched, a moved one is closed and reopened, a new one inserted', () => {
  const current: PriceRow[] = [
    { type_id: 34, adjusted_price: 4.58, average_price: 4.6 },
    { type_id: 35, adjusted_price: 10, average_price: null },
  ]
  const fetched: PriceRow[] = [
    { type_id: 34, adjusted_price: 4.58, average_price: 4.6 },
    { type_id: 35, adjusted_price: 11, average_price: null },
    { type_id: 36, adjusted_price: 100, average_price: 99 },
  ]
  const { touchIds, closeIds, inserts } = partition(current, fetched)
  assert.deepEqual(touchIds, [34])
  assert.deepEqual(closeIds, [35])
  assert.deepEqual(inserts, [
    { type_id: 35, adjusted_price: 11, average_price: null },
    { type_id: 36, adjusted_price: 100, average_price: 99 },
  ])
})

test('a type that left the listing is closed with no replacement', () => {
  const { touchIds, closeIds, inserts } = partition([{ type_id: 34, adjusted_price: 1, average_price: null }], [])
  assert.deepEqual(touchIds, [])
  assert.deepEqual(closeIds, [34])
  assert.deepEqual(inserts, [])
})

test('open rows arriving as PostgREST strings still match', () => {
  const current = [{ type_id: '34', adjusted_price: '4.58', average_price: null }] as unknown as PriceRow[]
  const { touchIds } = partition(current, [{ type_id: 34, adjusted_price: 4.58, average_price: null }])
  assert.deepEqual(touchIds, [34])
})

test('the plausibility floor is well under the listing and well over a stub', () => {
  assert.ok(MIN_PLAUSIBLE_TYPES > 1000 && MIN_PLAUSIBLE_TYPES < 14000)
})
