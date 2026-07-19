// The single module in the repo that talks to the Innominate Appraisal API
// (https://innomin.at/api/docs/) — an Evepraisal-style ISK price service. Both
// consumers (the appraise_items MCP tool now, the asset viewer in doc 03) go
// through here so the save:false invariant, auth header, in-process cache, and
// rate-limit handling live in exactly one place. This is a deliberate, narrow
// exception to the "UI/MCP read the DB, never call a third-party" rule: market
// prices aren't in our DB at all, so we call innomin.at server-side at request
// time. Nothing is persisted, and we still never call ESI. See
// docs/appraisals/README.md for the API reference and the 200 req/hour budget.
import { sortBy } from 'ramda'

export type AppraisalItemInput = { name: string; quantity: number }

export type AppraisedItem = {
  name: string
  itemId: number | null
  quantity: number
  itemVol: number | null
  totalItemVol: number | null
  sellPrice: number | null
  buyPrice: number | null
  totalSellPrice: number | null
  totalBuyPrice: number | null
  error: string | null // "Item not found" etc.
  possibleMatches: string[] // suggestions when error is set
}

export type Appraisal = {
  items: AppraisedItem[] // in request order
  totalVol: number
  totalSellValue: number
  totalBuyValue: number
  priceSplit: number
  market: string
  marketStatus: string
  rateLimitRemaining: number | null // from x-ratelimit-remaining
  cached: boolean // true when served from the TTL cache
}

export type AppraisalError =
  | { ok: false; kind: 'unconfigured'; message: string } // no INNOMINATE_API_KEY
  | { ok: false; kind: 'rate_limited'; message: string; retryAfterSeconds: number | null }
  | { ok: false; kind: 'upstream'; message: string } // 4xx/5xx/network/timeout

export type AppraisalResult = { ok: true; appraisal: Appraisal } | AppraisalError

export const MARKETS = ['jita', 'amarr', 'rens', 'dodi', 'hek', 'ualx', 'cj6mt'] as const
export type Market = (typeof MARKETS)[number]

const ENDPOINT = 'https://innomin.at/api/v1/appraise/'
// Matches the etiquette src/esi.js follows (identify us + a contact).
const USER_AGENT = 'edencom-link (philihp@gmail.com)'
const TIMEOUT_MS = 10_000

// The raw response shapes (snake_case) we map to the camelCase exports above.
type RawAppraisedItem = {
  name?: string
  item_id?: number | null
  quantity?: number
  item_vol?: number | null
  total_item_vol?: number | null
  sell_price?: number | null
  buy_price?: number | null
  total_sell_price?: number | null
  total_buy_price?: number | null
  error?: string | null
  possible_matches?: string[] | null
}
type RawAppraisal = {
  appraisals?: RawAppraisedItem[]
  total_vol?: number
  total_sell_value?: number
  total_buy_value?: number
  price_split?: number
  market?: string
  market_status?: string
}

const num = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null)

const mapItem = (r: RawAppraisedItem): AppraisedItem => ({
  name: r.name ?? '',
  itemId: num(r.item_id),
  quantity: r.quantity ?? 0,
  itemVol: num(r.item_vol),
  totalItemVol: num(r.total_item_vol),
  sellPrice: num(r.sell_price),
  buyPrice: num(r.buy_price),
  totalSellPrice: num(r.total_sell_price),
  totalBuyPrice: num(r.total_buy_price),
  error: r.error ?? null,
  possibleMatches: r.possible_matches ?? [],
})

// ---- In-process TTL cache -------------------------------------------------
//
// Both consumers re-request identical batches (double-clicks, an LLM re-asking
// the same question); the 200 req/hour budget makes that expensive, so we
// absorb bursts here. On Vercel this Map is per-lambda-instance and evaporates
// on cold starts — that's fine. It exists to smooth repeats, NOT to be a
// durable price store; market prices don't move fast enough for a 5-minute TTL
// to matter. Only successful results are cached; errors never are.
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 200
const cache = new Map<string, { at: number; appraisal: Appraisal }>()

// Key on market + the item list sorted by name, so batches that differ only in
// input order hit the same entry.
const cacheKey = (items: AppraisalItemInput[], market: Market): string =>
  JSON.stringify({ market, items: sortBy((i) => i.name, items).map((i) => [i.name, i.quantity]) })

const cacheGet = (key: string): Appraisal | null => {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.appraisal
}

const cacheSet = (key: string, appraisal: Appraisal): void => {
  cache.set(key, { at: Date.now(), appraisal })
  // Insertion-order sweep — evict the oldest entries once over the cap.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

// ---- The one call ---------------------------------------------------------

export const appraise = async (items: AppraisalItemInput[], market: Market = 'jita'): Promise<AppraisalResult> => {
  const apiKey = process.env.INNOMINATE_API_KEY
  if (!apiKey) {
    // No key locally → answer without hitting the network, so dev without the
    // key still works.
    return { ok: false, kind: 'unconfigured', message: 'INNOMINATE_API_KEY is not set on this deployment.' }
  }

  const key = cacheKey(items, market)
  const cached = cacheGet(key)
  if (cached) return { ok: true, appraisal: { ...cached, cached: true } }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      // save: false is HARD-CODED (never a parameter, never configurable):
      // it keeps the call side-effect-free on the provider's server — nothing
      // stored, no appraisal id minted — per the API-key agreement.
      body: JSON.stringify({ items, market, save: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Network error or the 10s timeout aborting — never throw.
    return { ok: false, kind: 'upstream', message: 'Could not reach the appraisal service (network error or timeout).' }
  }

  if (response.status === 429) {
    // 200/hour is a hard budget; a retry loop is how it dies. Surface the
    // wait instead of retrying automatically.
    const resetAfter = response.headers.get('x-ratelimit-reset-after')
    const retryAfterSeconds = resetAfter != null && resetAfter !== '' ? Number(resetAfter) : null
    return {
      ok: false,
      kind: 'rate_limited',
      message: 'The appraisal service is rate limited (200 requests/hour, shared).',
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    }
  }

  if (!response.ok) {
    const message = await response
      .json()
      .then((body: { error?: string }) => body?.error ?? `Appraisal service returned ${response.status}.`)
      .catch(() => `Appraisal service returned ${response.status}.`)
    return { ok: false, kind: 'upstream', message }
  }

  const raw: RawAppraisal = await response.json().catch(() => ({}))
  const remaining = response.headers.get('x-ratelimit-remaining')
  const rateLimitRemaining =
    remaining != null && remaining !== '' && Number.isFinite(Number(remaining)) ? Number(remaining) : null

  const appraisal: Appraisal = {
    items: (raw.appraisals ?? []).map(mapItem),
    totalVol: raw.total_vol ?? 0,
    totalSellValue: raw.total_sell_value ?? 0,
    totalBuyValue: raw.total_buy_value ?? 0,
    priceSplit: raw.price_split ?? 0,
    market: raw.market ?? market,
    marketStatus: raw.market_status ?? '',
    rateLimitRemaining,
    cached: false,
  }
  cacheSet(key, appraisal)
  return { ok: true, appraisal }
}
