// The /asset valuation chart's folds (src/app/asset/valuation.ts): stored
// per-owner daily values summed into one series, with a short carry over a
// missed day.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CARRY_DAYS,
  formatPct,
  valueAxis,
  valueSeries,
  windowChange,
  windowDays,
  type ValueParts,
  type ValueRow,
  zeroParts,
} from '../src/app/asset/valuation.ts'

const row = (
  ownerId: string,
  day: string,
  hangar: number,
  unpricedTypes = 0,
  parts: Partial<ValueParts> = {}
): ValueRow => ({
  ownerId,
  day,
  parts: { ...zeroParts(), hangar, ...parts },
  unpricedTypes,
})

test('windowDays: the trailing days that end with today, oldest first', () => {
  const now = Date.parse('2026-11-26T19:00:00Z')
  assert.deepEqual(windowDays(now, 3), ['2026-11-24', '2026-11-25', '2026-11-26'])
  assert.deepEqual(windowDays(now, 1), ['2026-11-26'])
})

test('valueSeries sums every owner on a day, largest owner first', () => {
  const points = valueSeries([row('a', '2026-11-01', 100), row('b', '2026-11-01', 300, 2)], ['2026-11-01'])
  assert.equal(points[0].total, 400)
  assert.deepEqual(
    points[0].owners.map((o) => o.ownerId),
    ['b', 'a']
  )
  assert.equal(points[0].unpricedTypes, 2)
  assert.equal(points[0].t, Date.parse('2026-11-01T00:00:00Z'))
})

test('valueSeries adds every part of an owner to its total, and sums each part', () => {
  const points = valueSeries(
    [
      row('a', '2026-11-01', 100, 0, { jobs: 40, market: 25, contracts: 10, cash: 5 }),
      row('b', '2026-11-01', 300, 0, { cash: 20 }),
    ],
    ['2026-11-01']
  )
  assert.equal(points[0].total, 500)
  assert.deepEqual(points[0].parts, { hangar: 400, jobs: 40, market: 25, contracts: 10, cash: 25 })
  assert.equal(points[0].owners.find((o) => o.ownerId === 'a')?.value, 180)
  assert.deepEqual(valueSeries([], ['2026-11-01'])[0].parts, zeroParts())
})

test('valueSeries carries a missed day forward, marked carried, for CARRY_DAYS only', () => {
  const rows = [row('a', '2026-11-01', 100), row('b', '2026-11-01', 50), row('b', '2026-11-02', 60)]
  const days = ['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06']
  const points = valueSeries(rows, days)
  // 2 Nov: a carried from the 1st, b on its own row.
  assert.equal(points[0].total, 160)
  assert.equal(points[0].owners.find((o) => o.ownerId === 'a')?.carried, true)
  assert.equal(points[0].owners.find((o) => o.ownerId === 'b')?.carried, false)
  // 4 Nov is CARRY_DAYS after a's last row: still carried.
  assert.equal(CARRY_DAYS, 3)
  assert.equal(points[1].total, 160)
  // 5 Nov: a is past the carry; b (last row the 2nd) is still within it.
  assert.equal(points[2].total, 60)
  // 6 Nov: nobody.
  assert.equal(points[3].total, null)
  assert.deepEqual(points[3].owners, [])
})

test('valueSeries keeps only the owners the filter accepts', () => {
  const points = valueSeries(
    [row('a', '2026-11-01', 100), row('b', '2026-11-01', 300)],
    ['2026-11-01'],
    (id) => id === 'a'
  )
  assert.equal(points[0].total, 100)
})

test('windowChange compares the first and last known totals', () => {
  const points = valueSeries(
    [row('a', '2026-11-02', 200), row('a', '2026-11-03', 250)],
    ['2026-11-01', '2026-11-02', '2026-11-03']
  )
  assert.deepEqual(windowChange(points), { first: 200, last: 250, delta: 50, pct: 0.25 })
  assert.equal(windowChange(valueSeries([], ['2026-11-01'])), null)
})

test('valueAxis brackets the totals in round steps and never goes below zero', () => {
  const points = valueSeries(
    [row('a', '2026-11-01', 41_200_000_000), row('a', '2026-11-02', 43_900_000_000)],
    ['2026-11-01', '2026-11-02']
  )
  const axis = valueAxis(points)
  assert.ok(axis.lo <= 41_200_000_000 && axis.lo > 0)
  assert.ok(axis.hi >= 43_900_000_000)
  assert.equal(axis.ticks[0], axis.lo)
  assert.equal(axis.ticks.at(-1), axis.hi)
  const empty = valueAxis([])
  assert.equal(empty.lo, 0)
  assert.ok(empty.hi > 0)
})

test('formatPct signs the change and dashes a missing base', () => {
  assert.equal(formatPct(0.0123), '+1.2%')
  assert.equal(formatPct(-0.004), '−0.4%')
  assert.equal(formatPct(null), '—')
})
