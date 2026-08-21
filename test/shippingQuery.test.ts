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
  describeTier,
  maxQuotableVolumeM3,
  resolveShippingRoute,
  tierForVolume,
} from '../src/app/api/mcp/shippingQuery.ts'

// The real load-size classes as of writing: only L is enabled on any lane, so
// 350,000 m³ is where a standard quote stops.
const CLASSES = [
  { id: 1, name: 'S', maxVolumeM3: 13_000 },
  { id: 2, name: 'M', maxVolumeM3: 67_000 },
  { id: 3, name: 'L', maxVolumeM3: 350_000 },
  { id: 4, name: 'XL', maxVolumeM3: null },
]

const tier = (tierId: number, enabled: boolean, ratePerM3: number) => ({
  tierId,
  enabled,
  pricingMode: 'per_m3',
  ratePerM3,
  flatRateIsk: null,
  minFeeIsk: 5_000_000,
  rushFeeIsk: 250_000_000,
})

// The real lanes as of writing: every origin appears as a destination too, so
// a one-endpoint query is genuinely ambiguous. Rates live on the tiers, never
// on the route.
const lane = (id: number, originName: string, destinationName: string, rate: number, collateralFeePercent = 0) => ({
  id,
  originName,
  destinationName,
  collateralFeePercent,
  tiers: [tier(1, false, rate), tier(2, false, rate), tier(3, true, rate), tier(4, false, rate)],
})

const ROUTES = [
  lane(1, 'C-J6MT', 'Jita', 900, 0.5),
  lane(2, 'Jita', 'C-J6MT', 700),
  lane(3, 'C-J6MT', 'N-HK93', 700),
  lane(4, 'N-HK93', 'Jita', 600, 0.5),
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
  assert.equal(describeRoute(ROUTES[1], CLASSES), '#2 Jita → C-J6MT (700 ISK/m³, up to 350,000 m³)')
  assert.equal(
    describeRoute(ROUTES[0], CLASSES),
    '#1 C-J6MT → Jita (900 ISK/m³, up to 350,000 m³, 0.5% collateral fee)'
  )
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

// ── Load-size tiers ───────────────────────────────────────────────────────
//
// Rates moved onto per-route tiers; reading them off the route itself is what
// made every lane quote "0 ISK/m³". These pin the arithmetic that replaced it,
// and the ceiling the page alerts on.

test('a route describes the rate of its enabled tier, not a rate of its own', () => {
  const described = describeRoute(ROUTES[1], CLASSES)
  assert.match(described, /700 ISK\/m³/)
  assert.match(described, /up to 350,000 m³/)
  // The disabled S/M/XL tiers price identically here and must not each be listed.
  assert.equal(described.match(/700 ISK\/m³/g)?.length, 1)
})

test('the ceiling is the largest ENABLED tier, not the largest tier', () => {
  // XL is unbounded but disabled, so the lane still stops at L's 350,000 m³.
  assert.equal(maxQuotableVolumeM3(ROUTES[1], CLASSES), 350_000)
})

test('an enabled unbounded tier means no ceiling at all', () => {
  const unbounded = { ...ROUTES[1], tiers: [tier(3, true, 700), tier(4, true, 900)] }
  assert.equal(maxQuotableVolumeM3(unbounded, CLASSES), null)
})

test('a route with nothing enabled quotes nothing', () => {
  const closed = { ...ROUTES[1], tiers: [tier(3, false, 700)] }
  assert.equal(maxQuotableVolumeM3(closed, CLASSES), 0)
  assert.equal(tierForVolume(closed, CLASSES, 1), null)
})

test('a load bills under the smallest enabled tier that fits it', () => {
  const tiered = { ...ROUTES[1], tiers: [tier(1, true, 1200), tier(2, true, 900), tier(3, true, 700)] }
  assert.equal(tierForVolume(tiered, CLASSES, 12_000)?.tierId, 1)
  assert.equal(tierForVolume(tiered, CLASSES, 13_000)?.tierId, 1) // the ceiling itself still fits
  assert.equal(tierForVolume(tiered, CLASSES, 13_001)?.tierId, 2)
  assert.equal(tierForVolume(tiered, CLASSES, 350_000)?.tierId, 3)
  // Past every enabled ceiling there is no tier — this is the over-capacity case.
  assert.equal(tierForVolume(tiered, CLASSES, 350_001), null)
})

test('a flat-rate tier describes its flat fee, not a per-m³ rate', () => {
  const flat = { ...tier(3, true, 0), pricingMode: 'flat', ratePerM3: null, flatRateIsk: 90_000_000 }
  assert.equal(describeTier(flat), '90,000,000 ISK flat')
})

test('rates are never abbreviated', () => {
  assert.equal(describeTier(tier(3, true, 1_250)), '1,250 ISK/m³')
})
