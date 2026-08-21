// Route-resolution seam for the shipping_quote MCP tool and the
// /asset/shipping page. Like planetQuery.ts this pulls in no I/O — callers
// fetch the KumGo route list and hand it here — so the fuzzy origin/
// destination matching, the tier arithmetic and the wording of a refusal are
// unit-testable without the network (see test/shippingQuery.test.ts).
//
// Types are declared structurally rather than imported from src/kumgo so the
// seam stays free of that module's fetch plumbing.

// A route's pricing for one load-size class. Rates live here, never on the
// route: a route enables the tiers it will haul, each with its own pricing.
export type ShippingTierLike = {
  tierId: number
  enabled: boolean
  pricingMode: string
  ratePerM3: number | null
  flatRateIsk: number | null
  minFeeIsk: number | null
  rushFeeIsk: number | null
}

export type ShippingRouteLike = {
  id: number
  originName: string
  destinationName: string
  collateralFeePercent: number
  tiers: ShippingTierLike[]
}

// The load-size classes themselves, shared by every route. A null ceiling
// means the class is unbounded.
export type TierClassLike = { id: number; name: string; maxVolumeM3: number | null }

const ceilingOf = (tierId: number, classes: TierClassLike[]): number | null =>
  classes.find((c) => c.id === tierId)?.maxVolumeM3 ?? null

// Enabled tiers, smallest ceiling first, an unbounded one last — the order a
// load should be fitted into them.
const enabledByCeiling = <T extends ShippingTierLike>(route: { tiers: T[] }, classes: TierClassLike[]): T[] =>
  route.tiers
    .filter((t) => t.enabled)
    .slice()
    .sort((a, b) => {
      const ca = ceilingOf(a.tierId, classes)
      const cb = ceilingOf(b.tierId, classes)
      if (ca === cb) return 0
      if (ca == null) return 1
      if (cb == null) return -1
      return ca - cb
    })

// The biggest load this route has a standard rate for: the largest ceiling
// among its enabled tiers, or null when one of them is unbounded. Null is
// therefore "no ceiling", never "unknown" — a route with nothing enabled
// returns 0, which refuses every load.
export const maxQuotableVolumeM3 = (route: ShippingRouteLike, classes: TierClassLike[]): number | null => {
  const tiers = enabledByCeiling(route, classes)
  if (tiers.length === 0) return 0
  const largest = tiers[tiers.length - 1]
  return ceilingOf(largest.tierId, classes)
}

// The tier a given load is billed under: the smallest enabled one that still
// fits it. Null when nothing does — the quote endpoint refuses those, and the
// UI says so before asking.
export const tierForVolume = (
  route: ShippingRouteLike,
  classes: TierClassLike[],
  volumeM3: number
): ShippingTierLike | null =>
  enabledByCeiling(route, classes).find((t) => {
    const ceiling = ceilingOf(t.tierId, classes)
    return ceiling == null || volumeM3 <= ceiling
  }) ?? null

// A tier's headline price, in whatever mode it bills. Full ISK, never
// abbreviated — these are numbers a player types into a contract.
export const describeTier = (tier: ShippingTierLike): string =>
  tier.pricingMode === 'flat'
    ? `${(tier.flatRateIsk ?? 0).toLocaleString('en-US')} ISK flat`
    : `${(tier.ratePerM3 ?? 0).toLocaleString('en-US')} ISK/m³`

export type RouteMatch<R extends ShippingRouteLike> = { ok: true; route: R } | { ok: false; message: string }

// A route as a single line, for a refusal or a menu. The rate comes from the
// route's enabled tiers — reading a rate off the route itself is what used to
// print "0 ISK/m³" for every lane. Tiers that price alike are collapsed, since
// every lane today enables exactly one.
export const describeRoute = (r: ShippingRouteLike, classes: TierClassLike[] = []): string => {
  const prices = [...new Set(enabledByCeiling(r, classes).map(describeTier))]
  const cap = maxQuotableVolumeM3(r, classes)
  const parts = [
    prices.length > 0 ? prices.join(' / ') : 'no standard rate',
    ...(cap != null && cap > 0 ? [`up to ${cap.toLocaleString('en-US')} m³`] : []),
    ...(r.collateralFeePercent > 0 ? [`${r.collateralFeePercent}% collateral fee`] : []),
  ]
  return `#${r.id} ${r.originName} → ${r.destinationName} (${parts.join(', ')})`
}

const routeList = (routes: ShippingRouteLike[], classes: TierClassLike[] = []): string =>
  routes.map((r) => describeRoute(r, classes)).join('; ')

// Resolve which route to quote: an explicit id wins, otherwise origin and
// destination are matched as case-insensitive substrings of the endpoint
// names ("jita" → Jita, "c-j6" → C-J6MT). Exactly one route must survive —
// ambiguity or a miss refuses with the full route list, which is short enough
// (a handful of lanes) to show whole.
export const resolveShippingRoute = <R extends ShippingRouteLike>(
  routes: R[],
  {
    routeId,
    origin,
    destination,
    // Only used to word a refusal's route list; matching itself ignores rates.
    classes = [],
  }: { routeId?: number; origin?: string; destination?: string; classes?: TierClassLike[] }
): RouteMatch<R> => {
  if (routes.length === 0) return { ok: false, message: 'The shipping service lists no active routes.' }

  if (routeId != null) {
    const route = routes.find((r) => r.id === routeId)
    return route
      ? { ok: true, route }
      : { ok: false, message: `No active route has id ${routeId}. Routes: ${routeList(routes, classes)}.` }
  }

  const from = (origin ?? '').trim().toLowerCase()
  const to = (destination ?? '').trim().toLowerCase()
  if (from === '' && to === '') {
    return {
      ok: false,
      message: `Name an origin and destination (or a route_id). Routes: ${routeList(routes, classes)}.`,
    }
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
        ? `No route runs ${asked}. Routes: ${routeList(routes, classes)}.`
        : `${matches.length} routes match ${asked}: ${routeList(matches, classes)}. Name both endpoints (or a route_id).`,
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
