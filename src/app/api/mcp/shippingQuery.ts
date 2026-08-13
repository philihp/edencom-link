// Route-resolution seam for the shipping_quote MCP tool. Like planetQuery.ts
// this pulls in no I/O — the tool fetches the KumGo route list and hands it
// here — so the fuzzy origin/destination matching is unit-testable without
// the network (see test/shippingQuery.test.ts).
//
// Route types are declared structurally rather than imported from src/kumgo
// so the seam stays free of that module's fetch plumbing.
export type ShippingRouteLike = {
  id: number
  originName: string
  destinationName: string
  ratePerM3: number
  collateralFeePercent: number
}

export type RouteMatch<R extends ShippingRouteLike> = { ok: true; route: R } | { ok: false; message: string }

export const describeRoute = (r: ShippingRouteLike): string =>
  `#${r.id} ${r.originName} → ${r.destinationName} (${r.ratePerM3} ISK/m³${
    r.collateralFeePercent > 0 ? ` + ${r.collateralFeePercent}% collateral` : ''
  })`

const routeList = (routes: ShippingRouteLike[]): string => routes.map(describeRoute).join('; ')

// Resolve which route to quote: an explicit id wins, otherwise origin and
// destination are matched as case-insensitive substrings of the endpoint
// names ("jita" → Jita, "c-j6" → C-J6MT). Exactly one route must survive —
// ambiguity or a miss refuses with the full route list, which is short enough
// (a handful of lanes) to show whole.
export const resolveShippingRoute = <R extends ShippingRouteLike>(
  routes: R[],
  { routeId, origin, destination }: { routeId?: number; origin?: string; destination?: string }
): RouteMatch<R> => {
  if (routes.length === 0) return { ok: false, message: 'The shipping service lists no active routes.' }

  if (routeId != null) {
    const route = routes.find((r) => r.id === routeId)
    return route
      ? { ok: true, route }
      : { ok: false, message: `No active route has id ${routeId}. Routes: ${routeList(routes)}.` }
  }

  const from = (origin ?? '').trim().toLowerCase()
  const to = (destination ?? '').trim().toLowerCase()
  if (from === '' && to === '') {
    return { ok: false, message: `Name an origin and destination (or a route_id). Routes: ${routeList(routes)}.` }
  }

  const matches = routes.filter(
    (r) =>
      (from === '' || r.originName.toLowerCase().includes(from)) &&
      (to === '' || r.destinationName.toLowerCase().includes(to))
  )
  if (matches.length === 1) return { ok: true, route: matches[0] }
  const asked = [origin && `from "${origin}"`, destination && `to "${destination}"`].filter(Boolean).join(' ')
  return {
    ok: false,
    message:
      matches.length === 0
        ? `No route runs ${asked}. Routes: ${routeList(routes)}.`
        : `${matches.length} routes match ${asked}: ${routeList(matches)}. Name both endpoints (or a route_id).`,
  }
}

// ── Collateral basis ──────────────────────────────────────────────────────

// When the caller sends a cargo manifest instead of a collateral figure, the
// tool appraises it (innomin.at) and collateralizes at one of these prices.
// Jita sell is the default: it's what replacing lost cargo actually costs at
// the market everything ultimately comes from.
export const COLLATERAL_BASES = [
  'jita_sell',
  'jita_buy',
  'jita_split',
  'cj6mt_sell',
  'cj6mt_buy',
  'cj6mt_split',
] as const
export type CollateralBasis = (typeof COLLATERAL_BASES)[number]

export const DEFAULT_COLLATERAL_BASIS: CollateralBasis = 'jita_sell'

// Which appraisal market a basis prices against — the names match the
// appraise_items market enum ('cj6mt' is the C-J6MT player market).
export const basisMarket = (basis: CollateralBasis): 'jita' | 'cj6mt' => (basis.startsWith('cj6mt') ? 'cj6mt' : 'jita')

export type AppraisalTotalsLike = { totalSellValue: number; totalBuyValue: number; priceSplit: number }

// Pick the appraisal total a basis collateralizes at.
export const basisValue = (basis: CollateralBasis, totals: AppraisalTotalsLike): number => {
  if (basis.endsWith('_sell')) return totals.totalSellValue
  if (basis.endsWith('_buy')) return totals.totalBuyValue
  return totals.priceSplit
}
