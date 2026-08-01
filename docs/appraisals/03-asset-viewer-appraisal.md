# 03 — Appraise buttons in the asset viewer

**Milestone 2.** One PR. A button on each row of the asset location page —
and one for the whole location — that lazy-loads an ISK appraisal: for a
plain stack, that stack; for a container or ship, the item **plus everything
nested inside it**. Requires doc 01 (`src/innominate.ts`) and doc 02 (the
`*_asset_subtree_items` functions) to be merged first.

## UX

On `/asset/[locationId]` (`src/app/asset/[locationId]/locationAssets.tsx`):

- New rightmost column **Value** in the assets table. Each row gets a small
  "appraise" button (text button in the retro table style — see
  `retro.module.css` usage; no icon fonts in this codebase).
- Click → button shows a busy state → replaced in place by the result:
  `4.03 bISK / 3.95 bISK` (sell / buy, via `formatBisk` from
  `src/app/isk.ts`; use `formatKisk` under 0.1b — match whichever the
  neighboring pages use for mixed magnitudes, `formatBisk` is the default).
  Add a `title` tooltip with the exact ISK figures, the line count, and any
  skips ("12 types · 3 blueprints skipped · 1 unpriced").
- Next to the page heading: an **Appraise everything here** button that
  appraises the whole location (`locationId` as the target). Same component,
  same endpoint.
- Errors render inline in the cell, small and quiet: `rate limited — retry
  in 42s`, `appraisal unavailable`. No toasts, no retries.
- The share-token (anonymous) path renders **no** Value column and no header
  button: the endpoint requires a session (see below), and the page already
  hides drill-down links in that mode. `page.tsx` passes a `canAppraise`
  boolean (simply `!scope`) down to `LocationAssets`.

Repeated clicks are absorbed by the client-module TTL cache (doc 01), but
also disable the button while a request is in flight.

## The endpoint — `POST /api/appraisal`

`src/app/api/appraisal/route.ts`, a plain route handler (this is a
client-triggered lazy fetch, so a route beats a server action — it wants
JSON, status codes, and no form semantics).

Request body: `{ "target": "<id>" }` — an item id (ship/container/stack) or
a bare location id (station / structure / solar system). Optional
`"market"` (validated against `MARKETS`, default `jita`) so the UI can grow
a picker later without an API change.

Auth: cookie session via `createClient` from `@/utils/supabase/server`;
`401` when there's no user. **Never** the service-role client — the doc-02
functions rely on RLS to scope the walk, and walking unscoped as
service_role would leak other users' items (same caveat the existing
`*_location_contents` calls document in `page.tsx`).

Server flow:

1. **Classify the target.** Query `character_asset` then `corp_asset` for
   `item_id = target` (mirror the `self` lookup in
   `src/app/asset/[locationId]/page.tsx`). Found → it's an item; keep its
   `(type_id, quantity, is_singleton)`. Not found → treat as a location id.
2. **Collect the subtree.** Call both RPCs in parallel —
   `character_asset_subtree_items` and `corp_asset_subtree_items` with
   `parent = target` — and merge the rows, summing quantities per
   `type_id`. (An item lives in exactly one table, so the union
   double-counts nothing.) If the target is an item, add its own line:
   singleton → 1, else its quantity.
3. **Filter blueprints.** Drop types whose SDE category is
   `BLUEPRINT_CATEGORY_ID` (9, exported by `src/app/api/mcp/lib.ts`) —
   asset rows can't distinguish worthless copies from originals, so pricing
   them would be wrong more often than right. Count them as
   `skipped_blueprints`.
4. **Guard the batch.** Zero lines → `{ ok: false, error: "nothing to
   appraise" }` (e.g. a container of only blueprints). More than **500
   distinct types** → refuse with a clear error rather than truncating (a
   silently partial total is worse than no total). 500 was **verified against
   the live API** (2026-08-01, one `save: false` request): a 500-entry batch
   returns `200` with all 500 appraisals present and no truncation, so the
   constant stands. The true ceiling is somewhere above 500 and was
   deliberately not probed — finding it would cost several more requests out
   of the 200/hour budget to raise a limit no real hangar has hit.
5. **Resolve names and appraise.** `getSdeTypeNames` over the type ids;
   types the SDE can't name are dropped into an `unpriced` list (the API is
   name-keyed, so an unnamed type can't be priced). One `appraise(lines,
   market)` call — never more.
6. **Respond.**

```jsonc
// 200
{
  "ok": true,
  "market": "jita",
  "total_sell_value": 4030000000,
  "total_buy_value": 3950000000,
  "price_split": 3990000000,
  "total_volume_m3": 5010.0,
  "line_count": 12,
  "skipped_blueprints": 3,            // omit when 0
  "unpriced": ["SomeType"],           // names the API couldn't price; omit when empty
  "cached": true,                     // omit when false
  "rate_limit_remaining": 197         // omit when null
}
```

Map `AppraisalError` kinds to statuses: `unconfigured` → `503`,
`rate_limited` → `429` with `retry_after_seconds`, `upstream` → `502`; the
zero-lines/too-many cases → `422`. Body always `{ ok: false, error, … }`.

Per-line prices are **not** returned in v1 — the UI only shows totals, and
the payload for a 500-type hangar would be pointless weight. The MCP tool
(doc 01) is the itemized view. If a drill-down UI is ever wanted, add an
`include_lines` flag then.

## Client component — `AppraiseButton`

`src/app/asset/[locationId]/appraiseButton.tsx`, `'use client'`, used both
per-row and (with the location id) next to the heading:

```tsx
export const AppraiseButton = ({ target }: { target: string }) => { … }
```

- `useState<'idle' | 'loading' | Result | Err>`; on click, `fetch('/api/appraisal',
  { method: 'POST', body: JSON.stringify({ target }) })`.
- Renders: idle → `<button>appraise</button>`; loading → `…`; success →
  the sell/buy figures (tooltip as described above; append `*` when
  `cached` — cheap honesty about staleness); error → the quiet inline
  message. State is per-mount; navigating away discards it (deliberate — no
  client-side store).
- Styling: a `.module.css` next to it if needed; follow `quantity.tsx` in
  the same directory as the pattern for a tiny presentational client
  component.

`LocationAssets` gains the column behind `canAppraise` (keep the
`colSpan` on the empty-state row in sync), and `page.tsx` renders the
header button only when `!scope`.

## Verification

1. `pnpm run lint` + `pnpm run build`.
2. `pnpm run dev`, sign in, open a station on `/asset`:
   - appraise a plain stack → value appears, matches `appraise_items` for
     the same type/quantity;
   - appraise a ship with fitted modules and cargo → total exceeds hull
     price; tooltip shows the line count;
   - appraise a container holding only blueprints → the 422
     "nothing to appraise" path renders sanely;
   - click the same target twice → second answer is instant and marked
     cached;
   - "Appraise everything here" on the station → plausible hangar total;
   - open a `/asset/[id]?token=…` share link → no Value column, no header
     button; `POST /api/appraisal` without a session → 401.
3. Watch `x-ratelimit-remaining` in the dev logs while testing — the whole
   session should cost a handful of requests, not dozens.
