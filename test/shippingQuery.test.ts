// Unit coverage for the shipping_quote route-resolution seam. What's worth
// pinning is the refusal behaviour: a quote must never go to the wrong lane,
// so anything short of exactly one surviving route — a miss, an ambiguous
// single endpoint, a bad id — refuses and shows the (short) route list.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  basisMarket,
  basisValue,
  COLLATERAL_BASES,
  DEFAULT_COLLATERAL_BASIS,
  describeRoute,
  resolveShippingRoute,
} from '../src/app/api/mcp/shippingQuery.ts'

// The real lanes as of writing: every origin appears as a destination too, so
// a one-endpoint query is genuinely ambiguous.
const ROUTES = [
  { id: 1, originName: 'C-J6MT', destinationName: 'Jita', ratePerM3: 900, collateralFeePercent: 0.5 },
  { id: 2, originName: 'Jita', destinationName: 'C-J6MT', ratePerM3: 700, collateralFeePercent: 0 },
  { id: 3, originName: 'C-J6MT', destinationName: 'N-HK93', ratePerM3: 700, collateralFeePercent: 0 },
  { id: 4, originName: 'N-HK93', destinationName: 'Jita', ratePerM3: 600, collateralFeePercent: 0.5 },
]

test('route id wins and must exist', () => {
  const hit = resolveShippingRoute(ROUTES, { routeId: 2 })
  assert.ok(hit.ok)
  assert.equal(hit.route.destinationName, 'C-J6MT')

  const miss = resolveShippingRoute(ROUTES, { routeId: 99 })
  assert.ok(!miss.ok)
  assert.match(miss.message, /No active route has id 99/)
  assert.match(miss.message, /#1 C-J6MT → Jita/)
})

test('origin/destination substrings match case-insensitively', () => {
  const match = resolveShippingRoute(ROUTES, { origin: 'jita', destination: 'c-j6' })
  assert.ok(match.ok)
  assert.equal(match.route.id, 2)
})

test('one endpoint resolves alone only when unambiguous', () => {
  // "to N-HK93" matches only route 3.
  const unique = resolveShippingRoute(ROUTES, { destination: 'n-hk' })
  assert.ok(unique.ok)
  assert.equal(unique.route.id, 3)

  // "to Jita" matches routes 1 and 4 — refused, listing just those two.
  const ambiguous = resolveShippingRoute(ROUTES, { destination: 'jita' })
  assert.ok(!ambiguous.ok)
  assert.match(ambiguous.message, /2 routes match to "jita"/)
  assert.match(ambiguous.message, /#1 /)
  assert.match(ambiguous.message, /#4 /)
})

test('a lane nobody runs refuses with the route list', () => {
  const miss = resolveShippingRoute(ROUTES, { origin: 'Jita', destination: 'Amarr' })
  assert.ok(!miss.ok)
  assert.match(miss.message, /No route runs from "Jita" to "Amarr"/)
  assert.match(miss.message, /#2 Jita → C-J6MT/)
})

test('no endpoints and no id asks for them', () => {
  const none = resolveShippingRoute(ROUTES, {})
  assert.ok(!none.ok)
  assert.match(none.message, /Name an origin and destination/)

  const empty = resolveShippingRoute([], { routeId: 1 })
  assert.ok(!empty.ok)
  assert.match(empty.message, /no active routes/)
})

test('describeRoute shows the collateral fee only when charged', () => {
  assert.equal(describeRoute(ROUTES[1]), '#2 Jita → C-J6MT (700 ISK/m³)')
  assert.equal(describeRoute(ROUTES[0]), '#1 C-J6MT → Jita (900 ISK/m³ + 0.5% collateral)')
})

// Every basis must map to exactly the market and total its name says — a
// mis-pick here silently mis-collateralizes real courier contracts.
test('collateral bases pick the named market and total', () => {
  const totals = { totalSellValue: 300, totalBuyValue: 100, priceSplit: 200 }
  assert.equal(DEFAULT_COLLATERAL_BASIS, 'jita_sell')
  assert.deepEqual(
    COLLATERAL_BASES.map((b) => [b, basisMarket(b), basisValue(b, totals)]),
    [
      ['jita_sell', 'jita', 300],
      ['jita_buy', 'jita', 100],
      ['jita_split', 'jita', 200],
      ['cj6mt_sell', 'cj6mt', 300],
      ['cj6mt_buy', 'cj6mt', 100],
      ['cj6mt_split', 'cj6mt', 200],
    ]
  )
})
