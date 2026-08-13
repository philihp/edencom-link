// The single module in the repo that talks to the KumGo freight service
// (https://kumgo.space) — a public, unauthenticated quote API for the
// alliance's shipping routes. Like src/innominate.ts this is a deliberate,
// narrow exception to the "UI/MCP read the DB, never call a third-party"
// rule: freight rates aren't in our DB, so the shipping_quote MCP tool calls
// kumgo.space server-side at request time. Nothing is persisted, nothing
// about the caller's account is sent — only route id, volume, collateral,
// and the rush flag. The API publishes no rate limit and quotes are pure
// arithmetic on its side, so unlike innomin.at there is no queue/throttle.
export type ShippingRoute = {
  id: number
  originName: string
  destinationName: string
  // Only the quote response carries the full station/structure name.
  destinationFullName: string | null
  ratePerM3: number
  collateralFeePercent: number
  flatRateIsk: number | null
  smallLoadMaxVolumeM3: number | null
  smallLoadRatePerM3: number | null
}

export type ShippingSettings = {
  minRewardIsk: number | null
  maxVolumeM3: number | null
  rushFeeIsk: number | null
}

export type ShippingQuote = {
  freightIsk: number
  rewardIsk: number
  rushFeeIsk: number
  totalIsk: number
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

const mapRoute = (r: Record<string, unknown>): ShippingRoute => ({
  id: num(r.id) ?? 0,
  originName: typeof r.originName === 'string' ? r.originName : '',
  destinationName: typeof r.destinationName === 'string' ? r.destinationName : '',
  destinationFullName: typeof r.destinationFullName === 'string' ? r.destinationFullName : null,
  ratePerM3: num(r.ratePerM3) ?? 0,
  collateralFeePercent: num(r.collateralFeePercent) ?? 0,
  flatRateIsk: num(r.flatRateIsk),
  smallLoadMaxVolumeM3: num(r.smallLoadMaxVolumeM3),
  smallLoadRatePerM3: num(r.smallLoadRatePerM3),
})

// Never throws — a network error, timeout, or surprise payload becomes a
// clean { ok: false } the MCP tool can hand to the model verbatim.
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
    // pass its own wording through (e.g. the max-volume message).
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
    settings: {
      minRewardIsk: num(raw.settings?.minRewardIsk),
      maxVolumeM3: num(raw.settings?.maxVolumeM3),
      rushFeeIsk: num(raw.settings?.rushFeeIsk),
    },
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
  // A refused quote (unknown route, over the volume cap) comes back as
  // { ok: false, error } on a 200 as well as on 4xx — treat both alike.
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
    },
    route: mapRoute(raw.route),
  }
}
