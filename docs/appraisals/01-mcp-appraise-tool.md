# 01 — `src/innominate.ts` client + `appraise_items` MCP tool

**Milestone 1.** One PR. Adds the single shared client for the Innominate
Appraisal API and the first consumer: an MCP tool that appraises a batch of
items by name. Read the [README](README.md) first — the API reference, the
`save: false` invariant, and the 200 req/hour rate limit all live there.

## Deliverables

1. `src/innominate.ts` — the only module in the repo that talks to
   innomin.at.
2. `appraise_items` MCP tool in `src/app/api/mcp/tools.ts`.
3. `INNOMINATE_API_KEY` added to `.env.example` (and set in Vercel before
   merge — the tool should degrade gracefully if unset, see below).

## 1. The client — `src/innominate.ts`

TypeScript (it's imported from app-router code), same top-level placement as
`src/esi.js`/`src/supabase.js`. Exports:

```ts
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
  error: string | null            // "Item not found" etc.
  possibleMatches: string[]       // suggestions when error is set
}

export type Appraisal = {
  items: AppraisedItem[]          // in request order
  totalVol: number
  totalSellValue: number
  totalBuyValue: number
  priceSplit: number
  market: string
  marketStatus: string
  rateLimitRemaining: number | null   // from x-ratelimit-remaining
  cached: boolean                     // true when served from the TTL cache
}

export type AppraisalError =
  | { ok: false; kind: 'unconfigured'; message: string }  // no INNOMINATE_API_KEY
  | { ok: false; kind: 'rate_limited'; message: string; retryAfterSeconds: number | null }
  | { ok: false; kind: 'upstream'; message: string }      // 4xx/5xx/network/timeout

export type AppraisalResult = { ok: true; appraisal: Appraisal } | AppraisalError

export const MARKETS = ['jita', 'amarr', 'rens', 'dodi', 'hek', 'ualx', 'cj6mt'] as const
export type Market = (typeof MARKETS)[number]

export const appraise = async (items: AppraisalItemInput[], market: Market = 'jita'): Promise<AppraisalResult>
```

Implementation requirements:

- `POST https://innomin.at/api/v1/appraise/` with headers `X-API-Key:
process.env.INNOMINATE_API_KEY`, `Content-Type: application/json`, and a
  `User-Agent` identifying us (`edencom-link (philihp@gmail.com)` — matches
  the etiquette `src/esi.js` follows).
- Body: `{ items, market, save: false }`. **`save: false` is hard-coded.**
  It is not a parameter of `appraise()`, not configurable, and a code
  comment must state why (side-effect-free on the provider's server, per
  the API-key agreement).
- Never mutate/merge caller input; map the response snake_case fields to the
  camelCase shapes above. Missing `possible_matches` → `[]`; missing/absent
  `item_id` → `null`.
- If `INNOMINATE_API_KEY` is unset/empty, return `kind: 'unconfigured'`
  without attempting a request (keeps local dev without the key working).
- On `429`, parse `x-ratelimit-reset-after` into `retryAfterSeconds`
  (null if absent). **No automatic retries** — with a 200/hour budget a
  retry loop is how the budget dies.
- On any other non-200, or a network error, return `kind: 'upstream'` with
  the response's `error` field when parseable (never throw). Apply an
  `AbortSignal.timeout` of ~10s.
- Read `x-ratelimit-remaining` into `rateLimitRemaining` on success.

### In-process TTL cache (part of the client, from day one)

Both consumers (MCP now, the asset viewer in doc 03) will re-request the
same batches; the rate limit makes that expensive. Cache **successful**
results in module scope:

- Key: `market` + the JSON of the item list sorted by name (so equal batches
  hit regardless of input order).
- TTL: 5 minutes. Cap: 200 entries, evict oldest-inserted beyond that (a
  plain `Map` insertion-order sweep is fine — no LRU library).
- A cache hit returns the stored `Appraisal` with `cached: true` and the
  stored `rateLimitRemaining` (stale but indicative).
- Errors are never cached.
- On Vercel this is per-lambda-instance and evaporates on cold starts —
  that's acceptable; it exists to absorb bursts (double-clicks, an LLM
  re-asking), not to be a durable price store. A code comment should say so.

Ramda house style applies (`map`/`sortBy`/`zipWith` over loops) for the
request/response mapping.

## 2. The MCP tool — `appraise_items`

Registered in `src/app/api/mcp/tools.ts` alongside the existing tools
(follow their structure exactly: `server.registerTool`, zod `inputSchema`,
`textResult` payloads from `./lib`).

```
appraise_items
  title: Appraise items
  description: Estimate the ISK market value of a batch of items via the
    innomin.at appraisal service (Jita by default). Answers "what's 3 Rifters
    and 100k Tritanium worth" or follows up a search_assets result with
    prices. Item names are matched fuzzily against EVE types. Prices are
    live market data, not the user's own orders.
  inputSchema:
    items: array of { item: string (min 1), quantity: int ≥ 1 default 1 },
           min 1, max 100 entries
    market: enum MARKETS, optional, default 'jita'
      describe: 'Market hub to price against (default jita). Others: amarr,
                 rens, dodi, hek, plus player markets ualx, cj6mt.'
```

No Supabase client and no auth-token use — the tool reads nothing from the
DB. (It still only runs for authenticated MCP callers because the whole
server sits behind `withMcpAuth`; that's what gates our 200/hour budget.)

### Name canonicalization (before calling the API)

The API wants exact names. LLM callers write approximations ("trit",
"nitrogen fuel block"). Resolve each input through the SDE the same way the
blueprint tools do (`resolveOneType` in tools.ts — best coverage match via
`searchSdeTypesAll`):

- SDE match found → send the canonical SDE name; remember when it differs
  from the input so the response can note `Interpreted "trit" as Tritanium`.
- No SDE match → **send the raw name anyway.** The API's own fuzzy handling
  returns `possible_matches` for it, which flow back to the model — better
  than failing locally.
- Duplicate resolved names in one call: merge quantities before sending
  (the API would otherwise price them as separate lines and inflate the
  batch).

### Tool output (via `textResult`)

```jsonc
{
  "market": "jita",
  "total_sell_value": 800030.0,
  "total_buy_value": 699350.0,
  "price_split": 749690.0,
  "total_volume_m3": 5010.0,
  "items": [
    {
      "item": "Tritanium",
      "quantity": 1000,
      "sell_price": 4.03,
      "buy_price": 3.95,
      "total_sell": 4030.0,
      "total_buy": 3950.0,
      "volume_m3": 10.0,
    },
  ],
  "unpriced": [
    // omit key when empty
    { "item": "Not A Real Item", "possible_matches": ["…", "…"] },
  ],
  "notes": ["Interpreted \"trit\" as Tritanium."], // omit when empty
  "cached": false, // omit when false
  "rate_limit_remaining": 198, // omit when null
  "source": "innomin.at",
}
```

Error mapping: `unconfigured` → "Appraisals aren't configured on this
deployment (missing INNOMINATE_API_KEY)."; `rate_limited` → include
`retryAfterSeconds`; `upstream` → pass the message through. All as plain
`textResult` strings, matching how the other tools report failures.

## 3. Env plumbing

- `.env.example`: add `INNOMINATE_API_KEY=` with a one-line comment pointing
  at https://innomin.at/api/docs/ (key issued via their Discord).
- Vercel: the repo owner sets the var (already present in the dev
  environment here).

## Verification (no test runner — do these by hand)

1. `pnpm run lint` and `pnpm run build` pass.
2. `pnpm run dev`, connect an MCP client (or drive
   `/api/mcp` with a bearer token) and call `appraise_items` with:
   - a normal batch (`Tritanium` ×1000, `Rifter` ×2) → totals match a
     manual curl;
   - a garbage name → lands in `unpriced` with `possible_matches`;
   - a fuzzy name ("trit") → canonicalized note appears;
   - the same batch twice within 5 minutes → second response has
     `"cached": true`;
   - `market: "amarr"` → different prices, `market` echoed.
3. Temporarily unset `INNOMINATE_API_KEY` → tool answers with the
   unconfigured message, no crash.
