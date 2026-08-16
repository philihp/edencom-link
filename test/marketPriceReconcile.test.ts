// Unit coverage for the market-prices SCD-2 seam. The job reconciles 20k+ rows
// per market every hour against a third-party feed, so the classification is
// both the easiest part to get subtly wrong and the most expensive: versioning
// one field too many turns the table into an append-only firehose, and
// mistaking an empty order book for a price of zero corrupts every downstream
// appraisal.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePrices, partitionPrices, signature } from '../src/jobs/marketPriceReconcile.js'

// A stored row as the reconcile classifies it, and the open row shape
// fetchCurrentRows selects. The job module is plain JS like its siblings, so
// the shapes are named here rather than inferred through ramda's combinators.
type PriceRow = { type_id: number; buy_max: number | null; sell_min: number | null; strategy: string | null }
// An open row as fetchCurrentRows selects it. There is no surrogate id: among a
// market's is_current rows (market, type_id) is unique, so the classifier's
// touch/close lists are type ids, and the job addresses rows with
// market + is_current + type_id.
type OpenRow = PriceRow
type Partition = { touchIds: number[]; closeIds: number[]; inserts: (PriceRow & { market: string })[] }

const partition = (market: string, current: OpenRow[] | undefined, fetched: PriceRow[] | undefined): Partition =>
  partitionPrices(market, current, fetched)

// One entry as appraise.gnf.lt returns it. An omitted side of the book still
// reports a numeric max/min — order_count is what says the book is empty.
const entry = (
  typeID: number | null,
  { buy, sell, strategy = 'orders' }: { buy?: number; sell?: number; strategy?: string } = {}
) => ({
  typeID,
  prices: {
    buy: buy === undefined ? { max: 0, order_count: 0 } : { max: buy, order_count: 3 },
    sell: sell === undefined ? { min: 0, order_count: 0 } : { min: sell, order_count: 3 },
    updated: '2026-08-16T02:59:15.014611036Z',
    strategy,
  },
})

test('normalizePrices lifts the best bid and best ask', () => {
  assert.deepEqual(normalizePrices([entry(34, { buy: 5.5, sell: 6.25 })]), [
    { type_id: 34, buy_max: 5.5, sell_min: 6.25, strategy: 'orders' },
  ])
})

test('an empty side of the book is null, not a price of zero', () => {
  const [row] = normalizePrices([entry(34, { sell: 6 })])
  assert.equal(row.buy_max, null)
  assert.equal(row.sell_min, 6)
})

test('float formatting drift below a hundredth is rounded away', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in IEEE 754. Undamped, arithmetic drift
  // like this opens a new version every hour for a price nobody moved.
  const [row] = normalizePrices([entry(34, { buy: 0.1 + 0.2 })])
  assert.equal(row.buy_max, 0.3)
})

test('a nine-figure price survives rounding intact', () => {
  const [row] = normalizePrices([entry(34, { sell: 72499999999.9 })])
  assert.equal(row.sell_min, 72499999999.9)
})

test('entries without a usable type id are dropped rather than stored under null', () => {
  assert.deepEqual(
    normalizePrices([{ typeID: null, prices: {} }, entry(34, { buy: 1 })]).map((r) => r.type_id),
    [34]
  )
})

test('a duplicated type id collapses to one row, last entry winning', () => {
  const rows = normalizePrices([entry(34, { buy: 1 }), entry(34, { buy: 2 })])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].buy_max, 2)
})

test('normalizePrices tolerates an absent feed', () => {
  assert.deepEqual(normalizePrices(undefined), [])
})

// The signature is what decides whether an hour writes a row or a timestamp.
test('the signature ignores everything that churns hourly', () => {
  const a = { buy_max: 5, sell_min: 6, strategy: 'orders', updated: '2026-08-16T01:00:00Z', volume: 10 }
  const b = { buy_max: 5, sell_min: 6, strategy: 'orders', updated: '2026-08-16T02:00:00Z', volume: 99 }
  assert.equal(signature(a), signature(b))
})

test('the signature separates an empty book from a zero price', () => {
  assert.notEqual(signature({ buy_max: null, sell_min: 6 }), signature({ buy_max: 0, sell_min: 6 }))
})

test('a change of pricing strategy opens a new version', () => {
  assert.notEqual(
    signature({ buy_max: 5, sell_min: 6, strategy: 'orders' }),
    signature({ buy_max: 5, sell_min: 6, strategy: 'ccp' })
  )
})

test('an unchanged price is touched, never rewritten', () => {
  const current = [{ type_id: 34, buy_max: 5, sell_min: 6, strategy: 'orders' }]
  const fetched = normalizePrices([entry(34, { buy: 5, sell: 6 })])
  const { touchIds, closeIds, inserts } = partition('jita', current, fetched)
  assert.deepEqual(touchIds, [34])
  assert.deepEqual(closeIds, [])
  assert.deepEqual(inserts, [])
})

test('a moved price closes the old version and opens a new one', () => {
  const current = [{ type_id: 34, buy_max: 5, sell_min: 6, strategy: 'orders' }]
  const fetched = normalizePrices([entry(34, { buy: 5.5, sell: 6 })])
  const { touchIds, closeIds, inserts } = partition('jita', current, fetched)
  assert.deepEqual(touchIds, [])
  assert.deepEqual(closeIds, [34])
  assert.deepEqual(inserts, [{ market: 'jita', type_id: 34, buy_max: 5.5, sell_min: 6, strategy: 'orders' }])
})

test('a type seen for the first time is inserted without closing anything', () => {
  const { touchIds, closeIds, inserts } = partition('jita', [], normalizePrices([entry(34, { buy: 5 })]))
  assert.deepEqual(touchIds, [])
  assert.deepEqual(closeIds, [])
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0].market, 'jita')
})

// Unlike the character-skills reconcile, absence is meaningful here: the feed
// is a complete listing, so a type dropping out means the service stopped
// pricing it.
test('a type the feed no longer prices is closed with no replacement', () => {
  const current = [
    { type_id: 34, buy_max: 5, sell_min: 6, strategy: 'orders' },
    { type_id: 35, buy_max: 7, sell_min: 8, strategy: 'orders' },
  ]
  const { touchIds, closeIds, inserts } = partition('jita', current, normalizePrices([entry(34, { buy: 5, sell: 6 })]))
  assert.deepEqual(touchIds, [34])
  assert.deepEqual(closeIds, [35])
  assert.deepEqual(inserts, [])
})

test('a moved price is closed once, not once per reason', () => {
  const current = [{ type_id: 34, buy_max: 5, sell_min: 6, strategy: 'orders' }]
  const { closeIds } = partition('jita', current, normalizePrices([entry(34, { buy: 9, sell: 9, strategy: 'ccp' })]))
  assert.deepEqual(closeIds, [34])
})

test('every row is classified into exactly one bucket', () => {
  const current = [
    { type_id: 34, buy_max: 5, sell_min: 6, strategy: 'orders' }, // unchanged
    { type_id: 35, buy_max: 7, sell_min: 8, strategy: 'orders' }, // moved
    { type_id: 36, buy_max: 1, sell_min: 2, strategy: 'orders' }, // gone
  ]
  const fetched = normalizePrices([
    entry(34, { buy: 5, sell: 6 }),
    entry(35, { buy: 7.5, sell: 8 }),
    entry(37, { buy: 3, sell: 4 }), // new
  ])
  const { touchIds, closeIds, inserts } = partition('jita', current, fetched)
  assert.deepEqual(touchIds, [34])
  assert.deepEqual(closeIds.sort(), [35, 36])
  assert.deepEqual(inserts.map((r) => r.type_id).sort(), [35, 37])
})

test('the reconcile tolerates a market with no history yet', () => {
  const { touchIds, closeIds, inserts } = partition('jita', undefined, undefined)
  assert.deepEqual({ touchIds, closeIds, inserts }, { touchIds: [], closeIds: [], inserts: [] })
})
