// The single module in the repo that talks to the Innominate Appraisal API
// (https://innomin.at/api/docs/) — an Evepraisal-style ISK price service. Both
// consumers (the appraise_items MCP tool now, the asset viewer in doc 03) go
// through here so the save:false invariant, auth header, in-process cache, and
// rate-limit handling live in exactly one place. This is a deliberate, narrow
// exception to the "UI/MCP read the DB, never call a third-party" rule: market
// prices aren't in our DB at all, so we call innomin.at server-side at request
// time. Nothing is persisted, and we still never call ESI. See
// docs/appraisals/README.md for the API reference and the 200 req/hour budget.
//
// Global throttle: the provider's 200 requests/hour is a budget for the WHOLE
// deployment, not per user or per lambda. In-process state can't enforce that —
// separate serverless instances don't share memory — so on Vercel every call is
// funnelled through a Vercel queue (topic "innominate", consumer at
// /api/queue/innominate) that drains at most one request every 18 seconds
// (= 200/hour) via an atomic Postgres leaky bucket. The MCP tool stays
// synchronous: appraise() enqueues the request and BLOCKS polling a shared
// Supabase row until the consumer fills it in (or a ~50s budget elapses). Local
// dev (no VERCEL) skips the queue and calls directly — a single developer isn't
// a threat to the shared budget, and it keeps `pnpm run dev` working.
import { requestKeyFor } from '@/innominateKey'
import { send } from '@/utils/queue'
import { createServiceClient } from '@/utils/supabase/service'

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

// The global drain rate: one request every 2 seconds.
//
// Deliberately faster than the provider's documented 200/hour (which works out
// to one per 18s, what this used to be). At 18s the throttle was the dominant
// cost of using the feature: the asset viewer puts an appraise button on every
// row, so a handful of clicks queued for a minute or more and the later ones
// timed out against the poll budget having never been sent at all. Draining at
// 2s serves a normal burst of clicks in a few seconds.
//
// The trade: this permits up to 1800/hour, so sustained heavy use can spend the
// real 200/hour budget in ~7 minutes and start collecting genuine 429s from
// innomin.at. That's an accepted risk at this deployment's traffic — a handful
// of players clicking occasionally, with the 5-minute result cache absorbing
// repeats — and a real 429 is surfaced to the user rather than retried. If it
// starts biting, the fix isn't a slower drip but an hourly token bucket: burst
// freely, then refuse once 200 have gone out in the trailing hour.
const THROTTLE_SECONDS = 2
// How long appraise() blocks polling the shared row before giving up — kept
// under the MCP route's 60s function limit (src/app/api/mcp/route.ts).
const POLL_BUDGET_MS = 50_000
const POLL_INTERVAL_MS = 1_000

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
// A per-lambda-instance fast path over the shared DB cache below: identical
// batches re-requested on the SAME instance (double-clicks, an LLM re-asking)
// skip the DB round-trip and the queue entirely. It evaporates on cold starts —
// that's fine; the shared innominate_appraisal row is the durable/global cache.
// Only successful results are cached; errors never are.
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 200
const cache = new Map<string, { at: number; appraisal: Appraisal }>()

// Key on market + the item list sorted by name, so batches that differ only in
// input order hit the same entry. Doubles as the shared row's request_key and
// the queue's idempotency key, both of which cap the key's size — see
// src/innominateKey.ts for why it's a digest and not the list itself.
const cacheKey = requestKeyFor

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

// ---- The raw call ---------------------------------------------------------
//
// Actually hits innomin.at. Only ever called by the queue consumer (one call at
// a time, throttled) — or directly by appraise() in local dev. Never throws.
const callInnominate = async (items: AppraisalItemInput[], market: Market): Promise<AppraisalResult> => {
  const apiKey = process.env.INNOMINATE_API_KEY
  if (!apiKey) {
    return { ok: false, kind: 'unconfigured', message: 'INNOMINATE_API_KEY is not set on this deployment.' }
  }

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
    // 200/hour is a hard budget; the throttle should keep us under it, but if
    // the provider still 429s, surface the wait — never retry automatically.
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
  return { ok: true, appraisal }
}

// ---- Shared DB row (throttle coordination + global cache) -----------------

type ServiceClient = ReturnType<typeof createServiceClient>
type AppraisalRow = {
  request_key: string
  market: string
  items: AppraisalItemInput[]
  status: 'pending' | 'done' | 'error'
  result: Appraisal | null
  error: AppraisalError | null
  updated_at: string
}

const readAppraisalRow = async (supabase: ServiceClient, requestKey: string): Promise<AppraisalRow | null> => {
  const { data } = await supabase
    .from('innominate_appraisal')
    .select('request_key, market, items, status, result, error, updated_at')
    .eq('request_key', requestKey)
    .maybeSingle()
  return (data as AppraisalRow | null) ?? null
}

const isFresh = (updatedAt: string): boolean => Date.now() - new Date(updatedAt).getTime() < CACHE_TTL_MS

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Block until the consumer fills in the shared row, or the poll budget elapses.
// Recursion rather than a while loop (ramda house style — sequential async).
const pollForResult = async (supabase: ServiceClient, key: string, deadline: number): Promise<AppraisalResult> => {
  const row = await readAppraisalRow(supabase, key)
  if (row?.status === 'done' && row.result) {
    const appraisal: Appraisal = { ...row.result, cached: false }
    cacheSet(key, appraisal)
    return { ok: true, appraisal }
  }
  if (row?.status === 'error' && row.error) return row.error
  if (Date.now() >= deadline) {
    // Still queued behind the global throttle backlog after our budget. Report
    // it as rate-limited so the caller retries rather than treating it as a hard
    // failure — the identical retry will find the by-then-cached result.
    return {
      ok: false,
      kind: 'rate_limited',
      message: 'The appraisal is queued behind the global rate limit; try again in a moment.',
      retryAfterSeconds: THROTTLE_SECONDS,
    }
  }
  await delay(POLL_INTERVAL_MS)
  return pollForResult(supabase, key, deadline)
}

const appraiseViaQueue = async (items: AppraisalItemInput[], market: Market, key: string): Promise<AppraisalResult> => {
  // appraise() must never throw (the MCP tool relies on that), so a DB or queue
  // outage becomes a clean upstream error rather than a rejection.
  try {
    const supabase = createServiceClient()

    // Global cache: a fresh 'done' row (< TTL) is reusable across every instance.
    const existing = await readAppraisalRow(supabase, key)
    if (existing?.status === 'done' && existing.result && isFresh(existing.updated_at)) {
      const appraisal: Appraisal = { ...existing.result, cached: true }
      cacheSet(key, appraisal)
      return { ok: true, appraisal }
    }

    // Upsert a pending row and enqueue one message for the consumer to drain. The
    // idempotency key is bucketed to the TTL so a hot key doesn't pile up
    // duplicate messages within a window, while a later request can re-drive a
    // stale row. Concurrent producers for the same key share this one row and both
    // poll it. (A rare race can reset a just-finished 'done' row back to pending,
    // costing one extra throttled call — harmless given the low request volume.)
    const { error: upsertError } = await supabase.from('innominate_appraisal').upsert(
      {
        request_key: key,
        market,
        items,
        status: 'pending',
        result: null,
        error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'request_key' }
    )
    // supabase-js returns write errors rather than throwing, so an unchecked
    // upsert fails silently: the consumer then finds no row to fill in and the
    // producer polls the full 50s budget before reporting a rate limit that was
    // never the problem. Surface it instead of enqueueing work with no row.
    if (upsertError) {
      return { ok: false, kind: 'upstream', message: `Could not record the appraisal request: ${upsertError.message}` }
    }

    const bucket = Math.floor(Date.now() / CACHE_TTL_MS)
    await send('innominate', { requestKey: key }, { idempotencyKey: `${key}:${bucket}` })

    return pollForResult(supabase, key, Date.now() + POLL_BUDGET_MS)
  } catch {
    return { ok: false, kind: 'upstream', message: 'Could not queue the appraisal request (queue or database error).' }
  }
}

// ---- Public entry point ---------------------------------------------------

export const appraise = async (items: AppraisalItemInput[], market: Market = 'jita'): Promise<AppraisalResult> => {
  if (!process.env.INNOMINATE_API_KEY) {
    // No key → answer without any network/queue work, so local dev without the
    // key still works and the tool degrades gracefully in prod if it's unset.
    return { ok: false, kind: 'unconfigured', message: 'INNOMINATE_API_KEY is not set on this deployment.' }
  }

  const key = cacheKey(items, market)
  const hit = cacheGet(key)
  if (hit) return { ok: true, appraisal: { ...hit, cached: true } }

  // Local dev has no Vercel queue infrastructure and is a single developer, so
  // it calls directly (bypassing the shared-budget throttle); production routes
  // every call through the throttled queue.
  if (process.env.VERCEL !== '1') {
    const result = await callInnominate(items, market)
    if (result.ok) cacheSet(key, result.appraisal)
    return result
  }

  return appraiseViaQueue(items, market, key)
}

// ---- Queue consumer entry point -------------------------------------------

// Thrown by the consumer when it isn't this message's turn under the global
// throttle; the queue route's retry handler turns it into a reschedule.
export class InnominateThrottleRetry extends Error {
  constructor(public readonly afterSeconds: number) {
    super('innominate request throttled')
    this.name = 'InnominateThrottleRetry'
  }
}

export type InnominateQueueMessage = { requestKey: string }

// Runs one queued appraisal request: reads its shared row, takes the global
// throttle slot (or throws InnominateThrottleRetry to reschedule), calls
// innomin.at, and writes the result/error back onto the row for the blocked
// producer to pick up. Called only by /api/queue/innominate.
export const runInnominateQueueMessage = async ({ requestKey }: InnominateQueueMessage): Promise<void> => {
  const supabase = createServiceClient()

  const row = await readAppraisalRow(supabase, requestKey)
  // Row expired/swept, or another delivery already satisfied it — nothing to do.
  if (!row) return
  if (row.status === 'done' && row.result && isFresh(row.updated_at)) return

  // Global throttle: at most one innomin.at request per THROTTLE_SECONDS across
  // every lambda instance and deployment (they share this Supabase project).
  const { data } = await supabase.rpc('innominate_try_acquire', { min_interval_seconds: THROTTLE_SECONDS })
  const gate = (Array.isArray(data) ? data[0] : data) as { acquired: boolean; wait_seconds: number } | null
  if (!gate?.acquired) {
    throw new InnominateThrottleRetry(Math.max(1, Math.ceil(gate?.wait_seconds ?? THROTTLE_SECONDS)))
  }

  const result = await callInnominate(row.items, row.market as Market)
  await supabase
    .from('innominate_appraisal')
    .update(
      result.ok
        ? { status: 'done', result: result.appraisal, error: null, updated_at: new Date().toISOString() }
        : { status: 'error', result: null, error: result, updated_at: new Date().toISOString() }
    )
    .eq('request_key', requestKey)
}
