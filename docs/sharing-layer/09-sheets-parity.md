# Sheets parity: links supersede the api_token CSV routes

**Status: in progress** — this phase's code ships alongside the link creator
UI (templates, fork, IMPORTDATA surfacing) and the `request.timing`
instrumentation the BRIN index project reads (`docs/brin-indexes/README.md`).

## Context

Seven bespoke CSV endpoints serve Google Sheets `=IMPORTDATA()`, authenticated
by the per-user `api_token` in the query string:

| Route                       | Postgres function             | `at=` time travel |
| --------------------------- | ----------------------------- | ----------------- |
| `/api/character/assets`     | `character_asset_snapshot_at` | yes               |
| `/api/character/blueprints` | `character_blueprints`        | no                |
| `/api/character/jobs`       | `character_industry_jobs`     | yes               |
| `/api/character/orders`     | `character_orders`            | yes               |
| `/api/corp/assets`          | `corp_assets`                 | no                |
| `/api/corp/blueprints`      | `corp_blueprints`             | no                |
| `/api/corp/jobs`            | `corp_industry_jobs`          | yes               |

The link CSV surface (`/link/[id]/csv?share=…`, `docs/sharing-layer/07-link.md`)
was always positioned to supersede them: a link is a stored GraphQL query, so
one general surface replaces seven bespoke ones, and sharing rides the unified
audience model instead of a bearer token that unlocks _everything_ the account
owns. This phase closes the parity gaps and starts the deprecation.

## Decisions

- **No time travel in links.** The GraphQL schema stays current-data-only —
  the `_over_time` SCD histories are deliberately not exposed (see
  `04-graphql-shared.md`). `at=` stays a legacy-route capability, documented as
  the one thing links do not replace. This is also load-bearing for
  measurement: the legacy `at=` requests are the `served: 'historical'` series
  the BRIN before/after comparison pivots on, so those routes cannot be removed
  until that project's measurement windows close.
- **Column-name parity is template authoring, not resolver code.** `toCsv`
  derives CSV headers from response keys, and GraphQL aliases control those
  keys — so a link template selecting `item_id: itemId` produces a
  byte-identical header row to the legacy route, and an existing sheet tab
  re-points cleanly. The drop-in templates in `src/app/link/templates.ts` pin
  this, tested against the routes' own column lists.
- **`output_count` is not carried over.** In the jobs RPCs it is an SQL join
  against `sde_blueprint_product` (`runs * product_quantity`), and on the
  legacy routes it is opt-in only (excluded from the default columns). The six
  plain columns the GraphQL `IndustryJob` type lacked (`blueprintId`,
  `blueprintLocationId`, `outputLocationId`, `facilityId`, `pauseDate`,
  `completedCharacterId`) are added instead; a sheet that needs `output_count`
  keeps the legacy route until removal, or derives it from
  `blueprint_for_product`.
- **Exports are uncapped up to `EXPORT_CAP`, and refuse beyond it.** The
  interactive GraphQL caps (`ASSET_CAP` 5000 / `LIST_CAP` 1000) exist so an
  ad-hoc query stays bounded; a Sheets tab can't page, so a capped CSV would be
  _silently_ short — the one failure mode worse than failing. The link CSV
  route runs its query with the caps raised to `EXPORT_CAP` (50 000, sized to
  what the uncapped legacy routes already serve inside the same 60 s budget)
  via `contextForUser(userId, { exporting: true })`, and answers 400 rather
  than emitting a shortened CSV when even that bound bites. An author's own
  smaller `limit:` argument is deliberate and passes untouched.

## Changes

1. **IndustryJob columns** — `schema.graphql.ts` + `resolvers.ts` add the six
   fields above (all `String` per the ids-overflow-Int house rule; the
   resolvers already `select('*')`, so the columns were on the wire).
   Drift-guarded in `test/graphqlSchema.test.ts`.
2. **Export caps** — `EXPORT_CAP` in `filters.ts`; `GraphqlContext.caps`
   (defaults `ASSET_CAP`/`LIST_CAP`) threaded through every resolver cap site;
   `runLink(link, { exporting })` → `contextForUser(userId, { exporting })`;
   the CSV route refuses at the bound.
3. **Drop-in templates** — one `LinkTemplate` per legacy route in
   `src/app/link/templates.ts`, aliasing every default column to its
   snake_case legacy name, tested for exact header equality in
   `test/linkTemplates.test.ts`.
4. **Deprecation** — `/account/settings` presents links as the primary Sheets
   integration for `link`-flagged accounts and moves the legacy formulas under
   a Deprecated heading; the seven routes answer a `Deprecation: true` header.

## What deprecation means here

- The routes stay live and instrumented. They are the `served: 'historical'`
  measurement instrument for `docs/brin-indexes/README.md`; removal is not
  scheduled before that project's per-table measurement windows have closed,
  and `at=` users have no link replacement to move to.
- Steering _all_ users to links requires lifting the `link` dark-launch flag
  (`src/flags.ts`) — a product call taken separately, not by this phase.
- When removal is eventually scheduled, it is its own phase with its own
  notice period; nothing in this phase breaks an existing `=IMPORTDATA()`
  formula.

## Tests

- `test/graphqlSchema.test.ts` — the six IndustryJob columns.
- `test/linkTemplates.test.ts` — every template validates against the schema;
  the drop-in templates' aliases equal the legacy routes' default column lists
  exactly.
- `test/linkValidate.test.ts` — `topLevelFieldOf` (the timing metric's `field`
  dimension).

## Verification

- Save a drop-in template as a link, link-share it, and diff
  `/link/<id>/csv?share=…` against the matching legacy route's output: header
  byte-identical, rows equal modulo ordering.
- A link whose result reaches `EXPORT_CAP` answers 400, not a shortened CSV.
- `request.timing` lines appear for both surfaces in Vercel Observability.
