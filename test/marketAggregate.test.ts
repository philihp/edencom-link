// Unit coverage for the market page's pure seams: the row → Trade mappers and
// the folds that feed the overview tiles (per side, per type, per
// counterparty, per bucket).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bucketTrades,
  inWindow,
  onSide,
  topCounterpartiesByValue,
  topTypesByValue,
  totalsBy,
  totalsOf,
  tradeValue,
} from '../src/app/market/aggregate.ts'
import { fromCharacterRow, fromCorpRow, type Trade } from '../src/app/market/trade.ts'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-11-01T00:00:00Z')
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString()

let nextId = 1
const trade = (over: Partial<Trade>): Trade => ({
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

test('fromCharacterRow maps is_buy to side and converts numeric strings', () => {
  const t = fromCharacterRow({
    transaction_id: '6123456789',
    registration_id: 'reg-a',
    is_buy: true,
    client_id: '2112625428',
    location_id: '60003760',
    date: at(1),
    type_id: '34',
    quantity: '10',
    unit_price: '4.50',
    seen_at: at(2),
  })
  assert.deepEqual(t, {
    transaction_id: 6123456789,
    side: 'buy',
    registration_id: 'reg-a',
    corporation_id: null,
    client_id: 2112625428,
    location_id: 60003760,
    date: at(1),
    type_id: 34,
    quantity: 10,
    unit_price: 4.5,
    seen_at: at(2),
  })
})

test('fromCorpRow carries the corporation and no registration', () => {
  const t = fromCorpRow({
    transaction_id: 7,
    corporation_id: '98000001',
    is_buy: false,
    client_id: 1000125,
    location_id: 60003760,
    date: at(1),
    type_id: 35,
    quantity: 2,
    unit_price: 3,
    seen_at: at(1),
  })
  assert.equal(t.side, 'sell')
  assert.equal(t.registration_id, null)
  assert.equal(t.corporation_id, 98000001)
})

test('tradeValue is unit price times quantity', () => {
  assert.equal(tradeValue(trade({ unit_price: 2.5, quantity: 4 })), 10)
})

test('inWindow is half-open', () => {
  const pred = inWindow(T0, T0 + HOUR)
  assert.equal(pred(trade({ date: at(0) })), true)
  assert.equal(pred(trade({ date: at(1) })), false)
  assert.equal(pred(trade({ date: at(-1) })), false)
})

test('onSide keeps one side only', () => {
  const trades = [trade({ side: 'sell' }), trade({ side: 'buy' }), trade({ side: 'sell' })]
  assert.equal(onSide('sell')(trades).length, 2)
  assert.equal(onSide('buy')(trades).length, 1)
})

test('totalsOf sums value, quantity and count; empty is zero', () => {
  assert.deepEqual(totalsOf([]), { total: 0, quantity: 0, count: 0 })
  assert.deepEqual(totalsOf([trade({ unit_price: 2, quantity: 3 }), trade({ unit_price: 10, quantity: 1 })]), {
    total: 16,
    quantity: 4,
    count: 2,
  })
})

test('totalsBy groups by the key', () => {
  const totals = totalsBy((t) => t.client_id)([
    trade({ client_id: 1, unit_price: 5 }),
    trade({ client_id: 2, unit_price: 7 }),
    trade({ client_id: 1, unit_price: 1, quantity: 2 }),
  ])
  assert.deepEqual(totals.get(1), { total: 7, quantity: 3, count: 2 })
  assert.deepEqual(totals.get(2), { total: 7, quantity: 1, count: 1 })
})

test('topTypesByValue ranks by ISK in the window, ties by type id, and limits', () => {
  const trades = [
    trade({ type_id: 35, unit_price: 100 }),
    trade({ type_id: 34, unit_price: 100 }),
    trade({ type_id: 36, unit_price: 50, quantity: 3 }),
    trade({ type_id: 37, unit_price: 1000, date: at(5) }), // outside the window
  ]
  const top = topTypesByValue(trades, T0, T0 + HOUR, 3)
  assert.deepEqual(
    top.map((t) => [t.typeId, t.total, t.quantity]),
    [
      [36, 150, 3],
      [34, 100, 1],
      [35, 100, 1],
    ]
  )
  assert.equal(topTypesByValue(trades, T0, T0 + HOUR, 1).length, 1)
})

test('topTypesByValue does not depend on input order', () => {
  const trades = [trade({ type_id: 35, unit_price: 9 }), trade({ type_id: 34, unit_price: 9 })]
  assert.deepEqual(topTypesByValue(trades, T0, T0 + HOUR, 5), topTypesByValue([...trades].reverse(), T0, T0 + HOUR, 5))
})

test('topCounterpartiesByValue ranks the client ids by ISK with counts', () => {
  const trades = [
    trade({ client_id: 1, unit_price: 10 }),
    trade({ client_id: 2, unit_price: 30 }),
    trade({ client_id: 1, unit_price: 10 }),
  ]
  assert.deepEqual(topCounterpartiesByValue(trades, T0, T0 + HOUR, 10), [
    { clientId: 2, total: 30, quantity: 1, count: 1 },
    { clientId: 1, total: 20, quantity: 2, count: 2 },
  ])
})

test('bucketTrades fills fixed-width buckets and drops trades outside the window', () => {
  const trades = [
    trade({ date: at(0), unit_price: 1 }),
    trade({ date: at(0.5), unit_price: 2 }),
    trade({ date: at(2), unit_price: 4 }),
    trade({ date: at(3), unit_price: 100 }), // at `end`: outside
    trade({ date: at(-1), unit_price: 100 }), // before `start`: outside
  ]
  const buckets = bucketTrades(trades, T0, T0 + 3 * HOUR, HOUR)
  assert.deepEqual(buckets, [
    { start: T0, end: T0 + HOUR, total: 3 },
    { start: T0 + HOUR, end: T0 + 2 * HOUR, total: 0 },
    { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR, total: 4 },
  ])
})

test('bucketTrades always gives at least one bucket', () => {
  assert.equal(bucketTrades([], T0, T0, HOUR).length, 1)
})
