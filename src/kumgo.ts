// The single module in the repo that talks to the KumGo freight service
// (https://kumgo.space) — a public, unauthenticated quote API for the
// alliance's shipping routes. Like src/innominate.ts this is a deliberate,
// narrow exception to the "UI/MCP read the DB, never call a third-party"
// rule: freight rates aren't in our DB, so the shipping_quote MCP tool and
// /asset/shipping call kumgo.space server-side at request time. Nothing is
// persisted, nothing about the caller's account is sent — only route id,
// volume, collateral, and the rush flag. The API publishes no rate limit and
// quotes are pure arithmetic on its side, so unlike innomin.at there is no
// queue/throttle.
//
// Rates are per *tier*, not per route. A tier is a load-size class — the
// settings payload names them and gives each a volume ceiling (S ≤13,000 m³,
// M ≤67,000 m³, L ≤350,000 m³, XL unbounded at the time of writing) — and each
// route enables the tiers it will actually haul, each with its own pricing.
// A load bigger than any enabled tier's ceiling has no standard rate and the
// quote endpoint refuses it. (The earlier flat `ratePerM3` on the route itself
// is gone; reading it left every rate showing as 0.)

export type ShippingTier = {
  tierId: number
  enabled: boolean
  // 'per_m3' bills ratePerM3 × volume; 'flat' bills flatRateIsk regardless.
  pricingMode: string
  ratePerM3: number | null
  flatRateIsk: number | null
  // Floor under the whole reward — a tiny load still pays this.
  minFeeIsk: number | null
  // Null means the tier will cover any collateral.
  maxCollateralIsk: number | null
  rushFeeIsk: number | null
}

export type ShippingRoute = {
  id: number
  originName: string
  destinationName: string
  // Only the quote response carries the full station/structure name.
  destinationFullName: string | null
  collateralFeePercent: number
  tiers: ShippingTier[]
}

// A load-size class, shared by every route; `tierId` on a route's tier refers
// to one of these. A null ceiling means the class is unbounded.
export type ShippingTierClass = {
  id: number
  name: string
  maxVolumeM3: number | null
}

export type ShippingSettings = {
  tiers: ShippingTierClass[]
}

export type ShippingQuote = {
  freightIsk: number
  rewardIsk: number
  rushFeeIsk: number
  totalIsk: number
  // The load's value ran past the tier's collateral ceiling, so the quote
  // covers less than the cargo is worth.
  collateralCapExceeded: boolean
}

export type ShippingRoutesResult =
  { ok: true; routes: ShippingRoute[]; settings: ShippingSettings } | { ok: false; message: string }

export type ShippingQuoteResult =
  { ok: true; quote: ShippingQuote; route: ShippingRoute } | { ok: false; message: string }

const BASE = 'https://kumgo.space'
// Matches the etiquette src/esi.js follows (identify us + a contact).
const USER_AGENT = 'edencom-link (philihp@gmail.com)'
const TIMEOUT_MS = 10_000

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const mapTier = (t: Record<string, unknown>): ShippingTier => ({
  tierId: num(t.tierId) ?? 0,
  enabled: t.enabled === true,
  pricingMode: typeof t.pricingMode === 'string' ? t.pricingMode : 'per_m3',
  ratePerM3: num(t.ratePerM3),
  flatRateIsk: num(t.flatRateIsk),
  minFeeIsk: num(t.minFeeIsk),
  maxCollateralIsk: num(t.maxCollateralIsk),
  rushFeeIsk: num(t.rushFeeIsk),
})

const mapRoute = (r: Record<string, unknown>): ShippingRoute => ({
  id: num(r.id) ?? 0,
  originName: typeof r.originName === 'string' ? r.originName : '',
  destinationName: typeof r.destinationName === 'string' ? r.destinationName : '',
  destinationFullName: typeof r.destinationFullName === 'string' ? r.destinationFullName : null,
  collateralFeePercent: num(r.collateralFeePercent) ?? 0,
  tiers: Array.isArray(r.tiers) ? r.tiers.map(mapTier) : [],
})

const mapTierClass = (t: Record<string, unknown>): ShippingTierClass => ({
  id: num(t.id) ?? 0,
  name: typeof t.name === 'string' ? t.name : '',
  maxVolumeM3: num(t.maxVolumeM3),
})

// Never throws — a network error, timeout, or surprise payload becomes a
// clean { ok: false } the caller can hand to the user verbatim.
const kumgoFetch = async (
  path: string,
  init?: RequestInit
): Promise<{ ok: true; body: any } | { ok: false; message: string }> => {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...init?.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { ok: false, message: 'Could not reach the KumGo shipping service (network error or timeout).' }
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    // The API reports request problems as { ok: false, error } with a 4xx;
    // pass its own wording through (e.g. the over-size message).
    const message = typeof body?.error === 'string' ? body.error : `KumGo returned ${response.status}.`
    return { ok: false, message }
  }
  return { ok: true, body }
}

export const fetchShippingRoutes = async (): Promise<ShippingRoutesResult> => {
  const result = await kumgoFetch('/api/routes')
  if (!result.ok) return result
  const raw = result.body ?? {}
  if (!Array.isArray(raw.routes)) return { ok: false, message: 'KumGo returned an unexpected route listing.' }
  return {
    ok: true,
    routes: raw.routes.map(mapRoute),
    settings: { tiers: Array.isArray(raw.settings?.tiers) ? raw.settings.tiers.map(mapTierClass) : [] },
  }
}

export const requestShippingQuote = async (
  routeId: number,
  volumeM3: number,
  collateralIsk: number,
  rush: boolean
): Promise<ShippingQuoteResult> => {
  const result = await kumgoFetch('/api/quote', {
    method: 'POST',
    body: JSON.stringify({ routeId, volumeM3, collateralIsk, rush }),
  })
  if (!result.ok) return result
  const raw = result.body ?? {}
  // A refused quote (unknown route, a load past every enabled tier) comes back
  // as { ok: false, error } on a 200 as well as on 4xx — treat both alike.
  if (raw.ok !== true || raw.quote == null || raw.route == null) {
    const message = typeof raw.error === 'string' ? raw.error : 'KumGo returned an unexpected quote payload.'
    return { ok: false, message }
  }
  return {
    ok: true,
    quote: {
      freightIsk: num(raw.quote.freightIsk) ?? 0,
      rewardIsk: num(raw.quote.rewardIsk) ?? 0,
      rushFeeIsk: num(raw.quote.rushFeeIsk) ?? 0,
      totalIsk: num(raw.quote.totalIsk) ?? 0,
      collateralCapExceeded: raw.quote.collateralCapExceeded === true,
    },
    route: mapRoute(raw.route),
  }
}
