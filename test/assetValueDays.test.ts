import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backfillPlan, daysBetween } from '../src/jobs/assetValueDays.js'

test('daysBetween lists every day, inclusive', () => {
  assert.deepEqual(daysBetween('2026-11-28', '2026-12-01'), ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'])
  assert.deepEqual(daysBetween('2026-11-28', '2026-11-27'), [])
})

const owners = [
  { key: 'a', first: '2026-11-01' },
  { key: 'b', first: '2026-11-03' },
]

test('backfillPlan goes day by day, each day every owner with history by then', () => {
  assert.deepEqual(backfillPlan({ owners, priceStart: '2026-10-01', today: '2026-11-04' }), [
    { day: '2026-11-01', keys: ['a'] },
    { day: '2026-11-02', keys: ['a'] },
    { day: '2026-11-03', keys: ['a', 'b'] },
    { day: '2026-11-04', keys: ['a', 'b'] },
  ])
})

test('backfillPlan starts no owner before the price record or since', () => {
  assert.deepEqual(backfillPlan({ owners, priceStart: '2026-11-02', since: '2026-11-04', today: '2026-11-04' }), [
    { day: '2026-11-04', keys: ['a', 'b'] },
  ])
  assert.deepEqual(backfillPlan({ owners, priceStart: '2026-11-02', today: '2026-11-03' }), [
    { day: '2026-11-02', keys: ['a'] },
    { day: '2026-11-03', keys: ['a', 'b'] },
  ])
})

test('backfillPlan leaves out owner-days already done, and days nobody needs', () => {
  const done = new Set(['a|2026-11-01', 'a|2026-11-03'])
  assert.deepEqual(backfillPlan({ owners, priceStart: '2026-10-01', today: '2026-11-03', done }), [
    { day: '2026-11-02', keys: ['a'] },
    { day: '2026-11-03', keys: ['b'] },
  ])
})

test('backfillPlan is empty with no owners', () => {
  assert.deepEqual(backfillPlan({ owners: [], priceStart: '2026-10-01', today: '2026-11-03' }), [])
})
