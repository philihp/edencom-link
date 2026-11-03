// The blueprint page's run fold (src/app/blueprint/item/history.ts): rows per
// job, totals over the counted ones, EIV through a price-at-moment function.
import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupeJobs, foldHistory, type HistoryJob, type HistoryPricing } from '../src/app/blueprint/item/history.ts'

const RIFTER_BP = 787
const RIFTER = 587
const TRITANIUM = 34
const PYERITE = 35

const job = (over: Partial<HistoryJob> & Pick<HistoryJob, 'job_id' | 'activity_id'>): HistoryJob => ({
  blueprint_type_id: RIFTER_BP,
  product_type_id: RIFTER,
  runs: 1,
  status: 'delivered',
  start_date: '2026-10-01T00:00:00Z',
  end_date: '2026-10-01T01:00:00Z',
  station_id: 60003760,
  owner_id: 'r1',
  ...over,
})

const pricing: HistoryPricing = {
  bills: {
    [RIFTER_BP]: [
      { typeID: TRITANIUM, quantity: 100 },
      { typeID: PYERITE, quantity: 10 },
    ],
  },
  products: { [RIFTER_BP]: { productTypeID: RIFTER, productQuantity: 1 } },
  // Tritanium 5 ISK, pyerite 10 ISK, at every moment but the one the
  // "at that time" test asks about; a 2024 install predates the record, so
  // its price is the earliest on record rather than the one in effect.
  priceAt: (typeId, at) => {
    if (at.startsWith('2025')) return null
    const price = typeId === TRITANIUM ? 5 : typeId === PYERITE ? 10 : null
    return price == null ? null : { price, exact: !at.startsWith('2024') }
  },
}

test('a run from before the price record is priced at the earliest price, marked approximate', () => {
  const { rows, totals } = foldHistory(
    [
      job({
        job_id: 1,
        activity_id: 1,
        runs: 10,
        start_date: '2024-06-01T00:00:00Z',
        end_date: '2024-06-01T01:00:00Z',
      }),
      job({ job_id: 2, activity_id: 1, runs: 1 }),
    ],
    pricing
  )
  const [recent, old] = rows
  assert.equal(recent.eivExact, true)
  assert.equal(old.eiv, 6000)
  assert.equal(old.eivExact, false)
  assert.equal(totals.pricedRuns, 2)
  assert.equal(totals.approximateRuns, 1)
  assert.equal(totals.eivProduced, 6600)
})

test('a manufacturing run makes runs × product quantity and carries its EIV', () => {
  const { rows, totals } = foldHistory([job({ job_id: 1, activity_id: 1, runs: 10 })], pricing)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].made, { kind: 'units', typeId: RIFTER, quantity: 10 })
  // (100 × 5 + 10 × 10) × 10 runs
  assert.equal(rows[0].eiv, 6000)
  assert.equal(rows[0].activityName, 'Manufacturing')
  assert.equal(rows[0].locationId, '60003760')
  assert.equal(totals.eivProduced, 6000)
  assert.equal(totals.pricedRuns, 1)
  assert.equal(totals.unpricedRuns, 0)
  assert.equal(totals.runs, 1)
})

test('the product quantity scales what was made', () => {
  const p: HistoryPricing = { ...pricing, products: { [RIFTER_BP]: { productTypeID: RIFTER, productQuantity: 5000 } } }
  const { rows } = foldHistory([job({ job_id: 1, activity_id: 1, runs: 2 })], p)
  assert.deepEqual(rows[0].made, { kind: 'units', typeId: RIFTER, quantity: 10000 })
})

test('a run the pricing cannot price is counted as unpriced, never guessed', () => {
  const { rows, totals } = foldHistory(
    [job({ job_id: 1, activity_id: 1, start_date: '2025-06-01T00:00:00Z', end_date: '2025-06-01T01:00:00Z' })],
    pricing
  )
  assert.equal(rows[0].eiv, null)
  assert.equal(totals.eivProduced, 0)
  assert.equal(totals.unpricedRuns, 1)
})

test('a run with no bill on record is unpriced', () => {
  const { rows } = foldHistory([job({ job_id: 1, activity_id: 1, blueprint_type_id: 999 })], pricing)
  assert.equal(rows[0].eiv, null)
})

test('cancelled and reverted runs are listed but never counted', () => {
  const { rows, totals } = foldHistory(
    [
      job({ job_id: 1, activity_id: 1, status: 'cancelled' }),
      job({ job_id: 2, activity_id: 5, status: 'reverted', runs: 3 }),
    ],
    pricing
  )
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => !r.counted))
  assert.equal(totals.runs, 0)
  assert.equal(totals.eivProduced, 0)
  assert.equal(totals.copies, 0)
})

test('copying makes one copy per run, with the licensed runs summed', () => {
  const { rows, totals } = foldHistory(
    [
      job({ job_id: 1, activity_id: 5, runs: 10, licensed_runs: 20, product_type_id: null }),
      job({ job_id: 2, activity_id: 5, runs: 2, licensed_runs: 5, product_type_id: null }),
    ],
    pricing
  )
  assert.deepEqual(rows[0].made, { kind: 'copies', typeId: RIFTER_BP, copies: 10, licensedRuns: 20 })
  assert.equal(totals.copies, 12)
  assert.equal(totals.licensedRuns, 210)
  assert.equal(rows[0].eiv, null)
})

test('invention reports successes over attempts', () => {
  const { rows, totals } = foldHistory(
    [job({ job_id: 1, activity_id: 8, runs: 4, successful_runs: 1, product_type_id: 12345 })],
    pricing
  )
  assert.deepEqual(rows[0].made, { kind: 'invented', typeId: 12345, successes: 1, attempts: 4 })
  assert.equal(totals.inventionAttempts, 4)
  assert.equal(totals.inventionSuccesses, 1)
})

test('research counts levels', () => {
  const { rows, totals } = foldHistory(
    [job({ job_id: 1, activity_id: 4, runs: 3, product_type_id: null }), job({ job_id: 2, activity_id: 3, runs: 1 })],
    pricing
  )
  assert.deepEqual(rows[0].made, { kind: 'research', levels: 3 })
  assert.equal(rows[0].activityName, 'ME Research')
  assert.equal(totals.researchLevels, 4)
})

test('rows come newest first', () => {
  const { rows } = foldHistory(
    [
      job({ job_id: 1, activity_id: 1, start_date: '2026-09-01T00:00:00Z' }),
      job({ job_id: 2, activity_id: 1, start_date: '2026-10-01T00:00:00Z' }),
    ],
    pricing
  )
  assert.deepEqual(
    rows.map((r) => r.jobId),
    ['2', '1']
  )
})

test('a job both views list counts once, for the corporation', () => {
  const jobs = dedupeJobs(
    [job({ job_id: 1, activity_id: 1, owner_id: 'r1' }), job({ job_id: 2, activity_id: 1, owner_id: 'r1' })],
    [job({ job_id: 1, activity_id: 1, owner_id: '98000001' })]
  )
  assert.deepEqual(
    jobs.map((j) => [String(j.job_id), j.owner_id]),
    [
      ['1', '98000001'],
      ['2', 'r1'],
    ]
  )
})
