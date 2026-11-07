// Unit coverage for the market page's tab seam: the saved tab, the copy per
// side, the counterparty label and the "Who" filter.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  byWho,
  capitalize,
  counterpartyLabel,
  parseSide,
  parseWho,
  SIDE_COPY,
  SIDES,
  whoOptions,
} from '../src/app/market/sides.ts'
import type { Trade } from '../src/app/market/trade.ts'

const trade = (over: Partial<Trade>): Trade => ({
  transaction_id: 1,
  side: 'sell',
  registration_id: 'r1',
  corporation_id: null,
  client_id: 100,
  location_id: 60003760,
  date: '2026-11-01T00:00:00Z',
  type_id: 34,
  quantity: 1,
  unit_price: 10,
  seen_at: '2026-11-01T01:00:00Z',
  ...over,
})

test('parseSide accepts the two sides and refuses anything else', () => {
  assert.equal(parseSide('sell'), 'sell')
  assert.equal(parseSide('buy'), 'buy')
  assert.equal(parseSide('sales'), undefined)
  assert.equal(parseSide(''), undefined)
})

test('every side has copy, and the counterparty is the other role', () => {
  SIDES.forEach((s) => assert.ok(SIDE_COPY[s].tab.length > 0))
  assert.equal(SIDE_COPY.sell.counterparty, 'buyer')
  assert.equal(SIDE_COPY.buy.counterparty, 'seller')
})

test('capitalize makes the first letter upper case', () => {
  assert.equal(capitalize('buyer'), 'Buyer')
  assert.equal(capitalize(''), '')
})

test('counterpartyLabel shows the name, or the raw id when no name is known', () => {
  const label = counterpartyLabel({ 100: 'Jita Trader' })
  assert.equal(label(100), 'Jita Trader')
  assert.equal(label(200), '#200')
})

test('whoOptions totals each counterparty, largest ISK first', () => {
  const trades = [
    trade({ transaction_id: 1, client_id: 100, quantity: 1, unit_price: 10 }),
    trade({ transaction_id: 2, client_id: 200, quantity: 3, unit_price: 10 }),
    trade({ transaction_id: 3, client_id: 100, quantity: 1, unit_price: 5 }),
  ]
  assert.deepEqual(whoOptions({ 100: 'Alpha' }, trades), [
    { clientId: 200, label: '#200', total: 30, quantity: 3, count: 1 },
    { clientId: 100, label: 'Alpha', total: 15, quantity: 2, count: 2 },
  ])
})

test('whoOptions sorts equal totals by label, then id, whatever the input order', () => {
  const names = { 300: 'Bravo', 100: 'Alpha' }
  const a = [trade({ client_id: 300 }), trade({ client_id: 100 }), trade({ client_id: 200 })]
  const order = (ts: Trade[]) => whoOptions(names, ts).map((o) => o.clientId)
  assert.deepEqual(order(a), [200, 100, 300])
  assert.deepEqual(order([...a].reverse()), [200, 100, 300])
})

test('whoOptions of no trades is empty', () => {
  assert.deepEqual(whoOptions({}, []), [])
})

test('byWho keeps every trade for null and one counterparty for an id', () => {
  const trades = [trade({ transaction_id: 1, client_id: 100 }), trade({ transaction_id: 2, client_id: 200 })]
  assert.equal(byWho(null)(trades).length, 2)
  assert.deepEqual(
    byWho(200)(trades).map((t) => t.transaction_id),
    [2]
  )
})

test('parseWho reads empty as everyone and refuses a value that is not an id', () => {
  assert.equal(parseWho(''), null)
  assert.equal(parseWho('90000001'), 90000001)
  assert.equal(parseWho('abc'), undefined)
  assert.equal(parseWho('-5'), undefined)
  assert.equal(parseWho('1.5'), undefined)
})
