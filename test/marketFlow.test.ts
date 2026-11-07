// Unit coverage for the market flow chart's pure folds: the two series, the
// cumulative net, the y axis, the x labels and the hover moment.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  flowAxis,
  flowBuckets,
  flowMoment,
  flowTick,
  netOf,
  niceStep,
  xTickEdges,
  type FlowBucket,
} from '../src/app/market/flow.ts'
import type { Trade } from '../src/app/market/trade.ts'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-11-01T00:00:00Z')
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString()

let nextId = 1
const trade = (over: Partial<Trade>): Trade => ({
  source: 'market',
  contract: null,
  transaction_id: nextId++,
  side: 'sell',
  registration_id: 'reg-a',
  corporation_id: null,
  client_id: 9000,
  location_id: 60003760,
  date: at(0),
  type_id: 34,
  quantity: 1,
  unit_price: 1,
  seen_at: at(0),
  ...over,
})

const row = (over: Partial<FlowBucket>): FlowBucket => ({
  start: T0,
  end: T0 + HOUR,
  sales: 0,
  purchases: 0,
  net: 0,
  cumulative: 0,
  ...over,
})

test('flowBuckets puts sales and purchases in the same buckets', () => {
  const trades = [
    trade({ side: 'sell', date: at(0.5), unit_price: 100, quantity: 2 }),
    trade({ side: 'buy', date: at(0.25), unit_price: 50 }),
    trade({ side: 'buy', date: at(2.5), unit_price: 300 }),
    // Outside the window: not counted on either side.
    trade({ side: 'sell', date: at(3), unit_price: 1000 }),
  ]
  const rows = flowBuckets(trades, T0, T0 + 3 * HOUR, HOUR)
  assert.deepEqual(rows, [
    { start: T0, end: T0 + HOUR, sales: 200, purchases: 50, net: 150, cumulative: 150 },
    { start: T0 + HOUR, end: T0 + 2 * HOUR, sales: 0, purchases: 0, net: 0, cumulative: 150 },
    { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR, sales: 0, purchases: 300, net: -300, cumulative: -150 },
  ])
  assert.equal(netOf(rows), -150)
})

test('flowBuckets with no trades gives empty buckets, and netOf of nothing is zero', () => {
  const rows = flowBuckets([], T0, T0 + 2 * HOUR, HOUR)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.sales === 0 && r.purchases === 0 && r.cumulative === 0))
  assert.equal(netOf([]), 0)
})

test('niceStep rounds up to 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceStep(0), 1)
  assert.equal(niceStep(-5), 1)
  assert.equal(niceStep(1), 1)
  assert.equal(niceStep(1.2), 2)
  assert.equal(niceStep(3), 5)
  assert.equal(niceStep(7), 10)
  assert.equal(niceStep(250_000), 500_000)
  assert.equal(niceStep(2_000_000), 2_000_000)
})

test('flowAxis keeps an idle window at a one-million scale', () => {
  const axis = flowAxis([row({})])
  assert.deepEqual(axis, { lo: 0, hi: 1_000_000, step: 500_000, ticks: [0, 500_000, 1_000_000] })
})

test('flowAxis holds the tallest bar and rounds up to a whole step', () => {
  const axis = flowAxis([row({ sales: 7_300_000, net: 7_300_000, cumulative: 7_300_000 })])
  assert.equal(axis.lo, 0)
  assert.equal(axis.step, 2_000_000)
  assert.equal(axis.hi, 8_000_000)
  assert.deepEqual(axis.ticks, [0, 2_000_000, 4_000_000, 6_000_000, 8_000_000])
})

test('flowAxis goes below zero when the net does, and zero is a tick', () => {
  const axis = flowAxis([
    row({ purchases: 30_000_000, net: -30_000_000, cumulative: -30_000_000 }),
    row({ sales: 10_000_000, net: 10_000_000, cumulative: -20_000_000 }),
  ])
  assert.ok(axis.lo <= -30_000_000)
  assert.ok(axis.hi >= 30_000_000)
  assert.ok(axis.ticks.includes(0))
  assert.ok(axis.ticks.every((t, i) => i === 0 || t - axis.ticks[i - 1] === axis.step))
  assert.ok(axis.ticks.length <= 6)
})

test('xTickEdges spaces the labels evenly from the window start', () => {
  assert.deepEqual(xTickEdges(24, 6), [0, 4, 8, 12, 16, 20, 24])
  assert.deepEqual(xTickEdges(7, 7), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(xTickEdges(90, 6), [0, 15, 30, 45, 60, 75, 90])
  assert.deepEqual(xTickEdges(1, 6), [0, 1])
})

test('flowTick and flowMoment speak UTC', () => {
  const t = Date.parse('2026-11-04T06:00:00Z')
  assert.equal(flowTick(t, 1), '06:00')
  assert.equal(flowTick(t, 6), '4 Nov 06:00')
  assert.equal(flowTick(t, 24), '4 Nov')
  assert.equal(flowMoment({ start: t, end: t + 6 * HOUR }, 6), '4 Nov 2026 06:00–12:00')
  assert.equal(flowMoment({ start: t, end: t + 24 * HOUR }, 24), '4 Nov 2026')
})
