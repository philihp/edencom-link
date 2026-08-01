# Price appraisals via innomin.at

Add ISK price appraisals to the app, powered by the
[Innominate Appraisal API](https://innomin.at/api/docs/) (an
Evepraisal-style service; the repo owner has an API key, provisioned as the
`INNOMINATE_API_KEY` env var). Two user-facing deliverables, shipped as
**separate PRs, in order** — each numbered document is a self-contained
implementation spec:

| Doc | PR | What | Status / dependency |
|---|---|---|---|
| [01-mcp-appraise-tool.md](01-mcp-appraise-tool.md) | **Milestone 1** | The shared `src/innominate.ts` API client + an `appraise_items` MCP tool (batch appraisal by item name) | Independent; do first |
| [02-asset-subtree-items.md](02-asset-subtree-items.md) | small | Postgres functions that aggregate a container/location subtree into `(type_id, quantity)` rows | Independent of 01 (pure DB); needed by 03 |
| [03-asset-viewer-appraisal.md](03-asset-viewer-appraisal.md) | **Milestone 2** | Appraise buttons in the asset viewer: lazy-load the appraisal of one stack, or a container/ship and everything inside it | After 01 (client) **and** 02 (DB functions) |

Future ideas deliberately **not** in scope (park them unless asked): a market
picker in the UI (everything defaults to Jita), appraising a `/asset/search`
result set, historical price tracking in our DB, and appraisal support on the
anonymous share-token pages.

## The API (validated 2026-07-17 against the live service)

OpenAPI schema: `https://innomin.at/api/schema/` (the `/api/docs/` page is a
Swagger UI over it). Everything below was confirmed with real requests using
our key.

### `POST /api/v1/appraise/` — the only endpoint we use

- **Auth:** `X-API-Key: <INNOMINATE_API_KEY>` header.
- **Request** (`application/json`):

  ```json
  {
    "items": [{ "name": "Tritanium", "quantity": 1000 }],
    "market": "jita",
    "save": false
  }
  ```

  - `items` — required, `minItems: 1`, each `{ name (required), quantity (int ≥ 1, default 1) }`.
    Appraisal is **by item name**, not type id; the service resolves the name
    itself and echoes the resolved `item_id` back.
  - `market` — default `jita`. Available: `jita`, `amarr`, `rens`, `dodi`,
    `hek`, `ualx`, `cj6mt` (the last two are player nullsec markets).
  - `save` — **`false` for every automatic appraisal**, which is the default
    everywhere and what all but one code path sends. `save: false` keeps the
    call side-effect free on the provider's server: nothing stored, no
    appraisal id minted.

    The single exception, added later at the repo owner's request, is the
    asset viewer's "open this appraisal" arrow (doc 03): an explicit user
    click that re-runs the same batch with `save: true` so the provider stores
    it and mints an id to link to. It is opt-in per call, never a default,
    and never set by the MCP tool or by merely displaying a price. Note this
    is a change from the original hard rule of "always false, hard-code it" —
    if the API-key terms ever require otherwise, this is the one call site to
    revoke.
  - `comment` — irrelevant when not saving; omit.

- **Response 200** (`AppraisalResponse`): `appraisals[]` (one entry per
  requested item, **in request order**), plus totals across the batch:

  ```json
  {
    "appraisals": [
      {
        "name": "Tritanium", "item_id": 34, "quantity": 1000,
        "item_vol": 0.01, "total_item_vol": 10.0,
        "sell_price": 4.03, "buy_price": 3.95,
        "sell_average": 3.74, "buy_average": 3.68,
        "total_sell_price": 4030.0, "total_buy_price": 3950.0,
        "error": null
      }
    ],
    "total_vol": 10.0, "total_sell_value": 4030.0, "total_buy_value": 3950.0,
    "price_split": 3990.0,
    "market": "jita", "market_status": "Ready",
    "corp_id": null, "comment": "", "current_count": 177609
  }
  ```

  - `sell_price` = current lowest sell, `buy_price` = current highest buy,
    `*_average` = historical averages, `price_split` = (sell+buy)/2 total.
  - **Unknown names don't fail the batch.** The entry comes back with
    `item_id` absent/null, every price field `null`,
    `"error": "Item not found"`, and a `possible_matches` string array of
    suggested names. Totals cover only the priced items.
  - `current_count` is the key's lifetime request counter (undocumented;
    don't rely on it).
  - `appraisal_id` is present only when `save: true` — a short slug (e.g.
    `2GeAakV`). A human opens it at **`https://innomin.at/a/<id>`** (the
    provider's SPA route, not in the OpenAPI schema, confirmed against a real
    saved appraisal); `GET /api/v1/appraisal/<id>/` returns it as JSON but
    requires the API key, so it's no use as a shareable link.

- **Errors:** `400` invalid request, `401` bad/missing key, `429` rate
  limited — all `{ "error": "…" }` JSON bodies.

### Rate limit — the central design constraint

Response headers (confirmed): `x-ratelimit-limit: 200/hour`,
`x-ratelimit-remaining`, `x-ratelimit-reset` (epoch seconds),
`x-ratelimit-reset-after` (seconds). **200 requests per hour, total, for the
whole deployment.** Consequences baked into the designs:

1. **One API call per appraisal action, always.** The endpoint is a batch
   endpoint — a whole container/hangar of distinct types goes in a single
   request. Never loop per item.
2. **Cache responses in-process** (5-minute TTL — see doc 01). Market prices
   don't move fast enough to matter, and repeated clicks on the same
   container must not spend the budget.
3. **Surface the remaining budget** (`x-ratelimit-remaining`) in tool/route
   responses, and turn a `429` into a friendly "try again in Ns" using
   `x-ratelimit-reset-after` — never retry automatically.

**Global throttle (added post-Milestone-1).** The in-process cache can't stop
several lambda instances from bursting past 200/hour together, so on Vercel
every `appraise()` call is funnelled through a Vercel queue (topic
`innominate`, consumer at `/api/queue/innominate`) that drains at most **one
request every 2 seconds** via an atomic Postgres leaky bucket
(`innominate_try_acquire()`).

That drain rate is deliberately **faster than the provider's 200/hour** (which
is one per 18s, what it originally was). At 18s the throttle became the
dominant cost of the feature once the asset viewer put an appraise button on
every row: a handful of clicks queued for over a minute, and the later ones
exhausted the poll budget without ever being sent. 2s serves a normal burst in
a few seconds. The trade is that it permits up to 1800/hour, so sustained heavy
use can spend the real budget in ~7 minutes and collect genuine 429s from
innomin.at (surfaced to the user, never retried). Accepted at this
deployment's traffic. If it starts biting, the answer isn't a slower drip but
an hourly token bucket — burst freely, refuse once 200 have gone out in the
trailing hour. `appraise()` keeps its synchronous contract: it
upserts a `pending` row in `innominate_appraisal`, enqueues one message, and
blocks polling that row (up to ~50s, under the MCP function's 60s limit) until
the consumer fills in the result — which also serves as a shared 5-minute price
cache across instances. Local dev (no `VERCEL`) skips the queue and calls
directly. See `src/innominate.ts` and
`supabase/migrations/20260719000000_innominate_appraisal_throttle.sql`.

### Privacy note

Requests to innomin.at carry **only type names and quantities** — never
owner, character, corporation, or location data. That's inherent to the
request shape, but keep it true: don't add comments or metadata to the
payload.

## Where this sits in the architecture

The CLAUDE.md data-flow rule says UI/MCP read the DB and never call ESI.
This project adds a **deliberate, narrow exception for a third-party price
API**: market prices are not in our DB at all, so both the MCP tool and the
asset-viewer route call innomin.at server-side at request time (they still
never call ESI, and nothing from innomin.at is persisted). All calls go
through the single client module `src/innominate.ts` (doc 01) so the
`save: false` invariant, auth header, caching, and rate-limit handling live
in exactly one place.

## House rules (from CLAUDE.md — these bite)

- **No test runner.** Gates are `pnpm run lint` + `pnpm run build`, plus
  manually exercising the MCP tool / pages touched. Every PR passes both.
- **Schema changes are dual-write:** edit `schema.sql` (full-reset source of
  truth) **and** add an incremental migration under `supabase/migrations/`
  (`pnpm run db:new <name>`); never rename an existing migration file.
- **Ramda over `for`/`while`** for synchronous iteration.
- **`git fetch origin && git rebase origin/main`** immediately before
  pushing and opening each PR. No exceptions.
- `INNOMINATE_API_KEY` goes in `.env.example` (doc 01) and must be set in
  the Vercel project before Milestone 1 deploys.
- Line numbers quoted in these docs will drift — anchor on the quoted code,
  not the numbers, and re-verify each call site before editing.
