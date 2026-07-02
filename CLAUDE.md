# Project overview

EVE Online hangar/wallet/industry tracker. Package name `edencom-link` (private). Deployed on Vercel.

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript 6, ESM (`"type": "module"`). Supabase (Postgres) for storage. `ramda` for utilities.
- **Node:** 24.16.0 (`.node-version`). **Package manager:** npm (`package-lock.json`).
- **Path alias:** `@/*` → `./src/*`.

## Commands

- `npm run dev` — Next dev server (default port 3000).
- `npm run build` / `npm start` — production build / serve.
- `npm run lint` — `eslint .` (flat config `eslint.config.mjs`; `no-explicit-any` is off, unused vars allowed with `^_` prefix).
- `npm run pretty` — `prettier --write src/` (config: `@philihp/prettier-config`).
- **No test runner / no `test` script** — there are no automated tests. No `typecheck` script (rely on `next build` / editor).
- Pre-commit: husky + lint-staged auto-format & `eslint --fix` staged files.
- `npm run sde:build` — downloads CCP's SDE type/group data and writes `src/generated/sdeTypes.json` (gitignored). Runs automatically as a `predev`/`prebuild` step; skips re-downloading if the file already exists (pass `--force` to refresh). See `src/buildSde.js`.
- Extract job scripts (one per ESI endpoint, run via GitHub Actions, see below): `npm run character-assets` / `character-orders` / `character-wallet` / `character-wallet-transactions` / `character-industry-jobs` / `character-affiliations` / `corp-structures` / `corp-assets` / `corp-wallet-journal` / `corp-wallet-transactions` / `corp-industry-jobs` / `industry-systems` / `universe-names` / `universe-structures`, plus `heartbeat`. `connect`, `ping`, `refresh` are DB/token utilities.
- DB migrations (Supabase CLI, configured by `supabase/config.toml`): `npm run db:new <name>` scaffolds a migration under `supabase/migrations/`; `npm run db:push` applies pending migrations to the linked project (`supabase link --project-ref <ref>` first). On push to `main` that touches `supabase/migrations/**`, the `Migrate` workflow runs `supabase db push` automatically (also manually dispatchable).

## Layout

- `src/app/` — Next.js App Router. Page routes: `account/`, `asset/`, `character/`, `industry/`, `market/`, `structure/`, plus `theme/`, `layout/` (Header/Footer), `private/`. Shared helpers at top level: `typeNames.ts`/`typeName.tsx`, `systemNames.ts`, `stationNames.ts`, `isk.ts`, `DateTime.tsx`.
- `src/` (Node cron/scripts): `esi.js` (ESI API wrapper), `supabase.js` (clients — anon + `sudoSupabase` service role that bypasses RLS), `resolveNames.js`, `tokenRefresh.js`/`refresh.js`, `proxy.ts`, `utils/`. The extract jobs live under `src/jobs/` — one file per ESI endpoint (`characterAssets.js`, `corpStructures.js`, …) plus the shared plumbing in `src/jobs/lib.js` (`forEachCharacter`/`forEachCorporation` token loops, `fetchAllPages`, `cli`). Each job exports a `run*` function (callable from the Vercel queue consumer) and self-runs as a CLI when invoked directly (`node src/jobs/<job>.js`).
- `schema.sql` — the single source of truth for the Supabase schema (in the default `public` schema). It's a full reset: it DROPs the app's tables and recreates them, so re-running wipes data — never run it against a database with data you want to keep. To change the schema, edit this file (so a fresh reset stays correct) **and** add a non-destructive incremental migration under `supabase/migrations/` (Supabase CLI format, applied with `supabase db push`) so the change can be rolled out to existing databases without wiping data.
- `.github/workflows/` — one workflow per extract job, named after it (`character-assets.yml`, `corp-structures.yml`, …; each a scheduled cron + manual dispatch with heartbeat start/end steps); `heartbeat.yml` (daily canary); `migrate.yml` (applies Supabase migrations on push to `main`).

## Database & ESI

- DB lives in the default `public` Postgres schema in Supabase (so supabase-js calls need no `.schema()` qualifier). Extract tables are named after the ESI endpoint that feeds them, prefixed by owner scope: `character_*`, `corp_*`, `universe_*` (see the table reference below). RLS enforced; cron uses service-role key.
- ESI base `https://esi.evetech.net/latest` via `src/esi.js`. Tokens (eve-sso OAuth) refreshed per character before fetching.
- **Data flow:** ESI → DB (extract jobs) → Next.js server components read DB. Server components must NOT call ESI directly.
- Env vars (`.env.example`): `EVE_CLIENT_ID`/`EVE_SECRET_KEY`/`EVE_CALLBACK_URL`, `SUPABASE_URL`/`SUPABASE_KEY`/`SUPABASE_SERVICE_KEY`/`SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`, Turnstile keys, `FLAGS_SECRET` (Vercel Flags SDK, see `src/flags.ts`).

# Workflow

- **Always** `git fetch origin && git rebase origin/main` on the feature branch immediately before pushing and opening a PR. Do this every time, no exceptions — it prevents merge conflicts and avoids PRs that include already-merged changes.

# Data sources

- NEVER query the `evesde` SDE schema in the database. That data is out of date and must not be used for any work. Resolve type/name lookups via `fetchTypeNames` (`src/app/typeNames.ts`), which reads the locally generated SDE data (`src/sdeTypes.ts`), instead. If a needed lookup has no non-SDE source, show the raw ID rather than reading the SDE.

# Architecture

- Data from ESI flows into the database via the per-endpoint extract jobs in `src/jobs/`. The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
- Avoid using the `evesde` schema in the database for new work — it can be out of date. Instead, type/group/category lookups are resolved from `src/generated/sdeTypes.json`, generated at build time by `src/buildSde.js` (`npm run sde:build`, wired as `predev`/`prebuild`) from CCP's published Static Data Export (via Fuzzwork's flat CSV mirror, which tracks each game patch). `src/sdeTypes.ts` loads that file once per server process and exposes `getSdeType`/`getSdeTypeNames`/`searchSdeTypes`, used by `src/app/typeNames.ts`, `src/app/blueprint/api.ts`, and `src/app/api/type/search/route.ts`. If a needed field isn't in the generated dataset, extend `src/buildSde.js` to include it rather than reaching into the `evesde` schema.

# Codebase map

Quick-reference for navigation. Covers key exports, route→file paths, DB tables, and design patterns.

## Key source file exports

### `src/buildSde.js` — SDE generator (run via `npm run sde:build`)
- Downloads `invTypes.csv`/`invGroups.csv` (Fuzzwork's flat-CSV mirror of CCP's SDE), joins them, and writes published types as `[typeID, name, groupID, categoryID]` tuples to `src/generated/sdeTypes.json` (gitignored). Skips re-downloading if the output already exists; pass `--force` to refresh.

### `src/sdeTypes.ts`
- `getSdeType(typeID)` — `{ typeID, name, groupID, categoryID }` from the generated SDE data, or `null`
- `getSdeTypeNames(typeIDs[])` — bulk id→name lookup
- `searchSdeTypes(query, limit?)` — case-insensitive substring search over type names, ranked by match coverage

### `src/esi.js` — ESI API wrapper
All functions take `(accessToken, id, ...)` unless noted. Returns raw ESI response JSON (paged wrappers return `[json, xPagesHeader]`).
- `assets(token, characterId, page)` — character assets list (paged)
- `transactions(token, characterId)` — market transaction history
- `wallet(token, characterId)` — wallet balance
- `orders(token, characterId)` — open market orders
- `industryJobs(token, characterId)` — industry job list
- `character(token, characterId)` — character sheet
- `corpStructures(token, corpId, page)` — corporation Upwell structures (paged)
- `corpAssets(token, corpId, page)` — corporation assets (paged)
- `corpIndustryJobs(token, corpId, page)` — corporation industry jobs (paged)
- `corpWalletJournal(token, corpId, division, page)` — corp wallet journal by division (paged)
- `corpTransactions(token, corpId, division)` — corp wallet market transactions for one division
- `assetNames(token, characterId, itemIds[])` — player-assigned names for specific item IDs
- `industrySystems()` — public industry system cost indices (no auth)
- `universeNames(ids[])` — bulk id→name resolution (no auth)
- `universeStructure(token, structureId)` — structure info by ID
- `characterAffiliations(characterIds[])` — bulk character→corp mapping (no auth)

### `src/jobs/lib.js` — shared extract-job plumbing
- `forEachCharacter(tag, { scope, characterIds }, handler)` — iterate tokens carrying an ESI scope, refresh each, call handler with `{ access_token, characterID, character_id, name, ctx }`
- `forEachCorporation(tag, { scope, characterIds }, handler)` — same, deduped to one handler call per corporation; also keeps `registration.corporation_id` fresh (corp-table RLS keys off it)
- `fetchAllPages(fetchPage)` — drain an x-pages-paginated ESI endpoint
- `cli(import.meta.url, tag, run)` — self-run a job module when invoked directly as a CLI

### `src/supabase.js` — Supabase clients and DB helpers
- `supabase` — anon client (respects RLS)
- `sudoSupabase` — service-role client (bypasses RLS; use in cron only)
- `recordHeartbeat(job, phase, opts)` — write heartbeat row
- `authenticate(token)` — verify user session token
- `upsertCharacter(characterId, name, ownerId, corporationId)` — insert/update registration row
- `upsertToken(characterId, accessToken, refreshToken, issuedAt, expiresAt, scope[])` — store OAuth tokens
- `upsertAssets(characterId, assets[])` — asset upsert (legacy `refresh.js` utility)
- `selectCharacters(userId)` — registered characters for a user
- `selectCharacterIdsWithScopes(scopes[])` — character IDs that have all listed ESI scopes
- `selectToken(characterId)` — fetch stored token for a character

### `src/tokenRefresh.js`
- `refreshAccessToken(tokenRow)` — refresh via EVE SSO, update DB, return new token

### `src/resolveNames.js`
- `resolveBatch(ids[])` / `resolveAllIds(ids[])` — bulk ESI `universeNames` with bisect-on-error fallback
- `resolveCorpJournalNames()` — resolve first/second party IDs seen in corp wallet journal rows into `universe_name`
- `resolveKnownCorpNames()` — resolve+cache corp names seen in `corp_wallet_transaction`/`character_affiliation`/`corp_structure`
- `resolveCorpStructureSystemNames()` — resolve system IDs for corp structures
- `resolveAssetStationNames()` — resolve+cache NPC station names (location_type 'station' in assets) into `universe_name`

### `src/utils/apiToken.ts`
- `resolvePlayer(token: string)` — look up `user_settings.api_token`, return `{ supabase, characterIds }` for Sheets API endpoints

### `src/utils/csv.ts`
- `toCsv(rows: object[])` — serialize flat object array to RFC 4180 CSV string

### `src/utils/supabase/client.ts` / `server.ts` / `service.ts`
- Browser / server-cookie / service-role Supabase client factories

## App routes → files

| URL path | File |
|---|---|
| `/` | `src/app/page.tsx` |
| `/account/login` | `src/app/account/login/page.tsx` |
| `/account/register` | `src/app/account/register/page.tsx` |
| `/account/settings` | `src/app/account/settings/page.tsx` |
| `/account/invite` | `src/app/account/invite/page.tsx` |
| `/asset` | `src/app/asset/page.tsx` |
| `/asset/[locationId]` | `src/app/asset/[locationId]/page.tsx` |
| `/character` | `src/app/character/page.tsx` |
| `/character/callback` | `src/app/character/callback/route.ts` |
| `/character/refresh` | `src/app/character/refresh/page.tsx` |
| `/market` | `src/app/market/page.tsx` |
| `/industry` | `src/app/industry/page.tsx` |
| `/structure` | `src/app/structure/page.tsx` |
| `/structure/[structureId]` | `src/app/structure/[structureId]/page.tsx` |
| `/settings/grants` | `src/app/settings/grants/page.tsx` |
| `/blueprint` | `src/app/blueprint/page.tsx` |
| `/blueprint/[typeID]` | `src/app/blueprint/[typeID]/page.tsx` |
| `/api/character/assets` | `src/app/api/character/assets/route.ts` |
| `/api/character/orders` | `src/app/api/character/orders/route.ts` |
| `/api/character/jobs` | `src/app/api/character/jobs/route.ts` |
| `/api/corp/assets` | `src/app/api/corp/assets/route.ts` |
| `/api/corp/jobs` | `src/app/api/corp/jobs/route.ts` |
| `/api/queue/jobs` | `src/app/api/queue/jobs/route.ts` |
| `/api/type/search` | `src/app/api/type/search/route.ts` |

The old CSV endpoint paths (`/api/assets`, `/api/orders`, `/api/industry`) and `/characters/refresh` permanently redirect to their new homes (see `next.config.mjs`) so existing Google Sheets keep working.

Shared UI helpers: `src/app/isk.ts` (ISK formatting), `src/app/DateTime.tsx`, `src/app/typeName.tsx` (renders a type name from ID), `src/app/typeNames.ts` (resolves type names from the locally generated SDE data), `src/app/systemNames.ts`, `src/app/stationNames.ts`.

## Extract jobs

One job per ESI endpoint. The npm script, queue job name, heartbeat job label, and workflow file all share the job's name; the entry point is the camelCased file under `src/jobs/` exporting `run<PascalCase>()` (e.g. `character-assets` → `src/jobs/characterAssets.js` → `runCharacterAssets()`).

| Job | ESI endpoint | Writes to | Schedule (UTC) |
|---|---|---|---|
| `character-assets` | `/characters/{id}/assets/` (+`/assets/names/`) | `character_asset_over_time` | hourly `:26` |
| `character-orders` | `/characters/{id}/orders/` | `character_order` | hourly `:24` |
| `character-wallet` | `/characters/{id}/wallet/` | `character_wallet` | hourly `:44` |
| `character-wallet-transactions` | `/characters/{id}/wallet/transactions/` | `character_wallet_transaction` | hourly `:46` |
| `character-industry-jobs` | `/characters/{id}/industry/jobs/` | `character_industry_job` | hourly `:48` |
| `character-affiliations` | `/characters/affiliation/` | `character_affiliation` | 11:41 daily |
| `corp-structures` | `/corporations/{id}/structures/` | `corp_structure` | 09:17 daily |
| `corp-assets` | `/corporations/{id}/assets/` | `corp_asset_over_time`, `corp_structure_rig` | 09:27 daily |
| `corp-wallet-journal` | `/corporations/{id}/wallets/{division}/journal/` | `corp_wallet_journal` | 09:37 daily |
| `corp-wallet-transactions` | `/corporations/{id}/wallets/{division}/transactions/` | `corp_wallet_transaction` | hourly `:50` |
| `corp-industry-jobs` | `/corporations/{id}/industry/jobs/` | `corp_industry_job` | 09:47 daily |
| `industry-systems` | `/industry/systems/` | `industry_system_index` | hourly `:10` |
| `universe-names` | `/universe/names/` | `universe_name` | hourly `:58` |
| `universe-structures` | `/universe/structures/{id}` | `universe_structure` | 09:57 daily |

`src/heartbeat.js` (`heartbeat.yml`, 10:55 daily) is a canary that just proves heartbeat recording works.

The per-character jobs (`character-*` except `character-affiliations`, plus `corp-wallet-transactions`) are also dispatched on demand via the Vercel queue at `/api/queue/jobs` (the "Refresh ESI" flow), fanned out one message per character; `character-affiliations` and `universe-names` are dispatched once account-wide. The daily corp jobs and `industry-systems` are cron-only — they do whole-corp/whole-universe work that isn't character-scoped.

## Database tables (quick reference)

| Table | Purpose | Notable columns |
|---|---|---|
| `registration` | Linked EVE characters | `character_id`, `user_id`, `name`, `corporation_id` |
| `token` | OAuth tokens | `character_id` (unique FK), `access_token`, `refresh_token`, `expires_at`, `scope[]` |
| `character_asset_over_time` | SCD Type 2 asset history | `item_id`, `character_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `is_current`, `first_seen_at`, `last_seen_at`, `name` |
| `character_asset` | View: `is_current` assets | same columns as above |
| `character_wallet` | Wallet balance history | `character_id`, `balance`, `recorded_at` |
| `character_wallet_transaction` | Trade history | `transaction_id`, `character_id`, `type_id`, `unit_price`, `quantity`, `is_buy`, `date` |
| `character_order` | Live open orders | `order_id`, `character_id`, `type_id`, `price`, `volume_remain`, `is_buy`, `seen_at` |
| `character_industry_job` | Manufacturing/research | `job_id`, `character_id`, `blueprint_id`, `product_type_id`, `activity_id`, `status`, `end_date` |
| `character_affiliation` | Character→Corp mapping | `character_id`, `corporation_id` |
| `corp_structure` | Corp Upwell structures | `structure_id`, `corporation_id`, `type_id`, `system_id`, `name`, `state`, `fuel_expires`, `services` (jsonb) |
| `corp_structure_rig` | Rigs on structures | `structure_id`, `location_flag`, `type_id`, `corporation_id` |
| `corp_wallet_journal` | Corp transaction log | `corporation_id`, `division`, `entry_id`, `ref_type`, `amount`, `date` |
| `corp_wallet_transaction` | Corp market buys/sells (unioned into market page) | `transaction_id`, `corporation_id`, `division`, `type_id`, `unit_price`, `quantity`, `is_buy`, `date` |
| `corp_asset_over_time` | SCD Type 2 corp asset history | `item_id`, `corporation_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `is_current`, `first_seen_at`, `last_seen_at` |
| `corp_asset` | View: `is_current` corp assets | same columns as above |
| `corp_industry_job` | Corp manufacturing/research jobs | `job_id`, `corporation_id`, `installer_id`, `blueprint_id`, `product_type_id`, `activity_id`, `status`, `end_date` |
| `industry_system_index` | Cost index history (append-only) | `system_id`, `activity`, `cost_index`, `recorded_at` |
| `universe_name` | Cached id→name | `id` (bigint PK), `name`, `category` |
| `universe_structure` | Player structure cache | `structure_id`, `name`, `system_id`, `type_id` |
| `user_settings` | User preferences | `user_id`, `enabled_scopes[]`, `api_token` (unique), `flags[]` |
| `invite_code` | Invite-only registration | `code` (unique), `created_by`, `redeemed_by`, `redeemed_at` |
| `refresh_task` | On-demand job tracking | `batch_id`, `user_id`, `job`, `character_id`, `status` (pending/running/done/error) |
| `heartbeat` | Cron job monitoring | `job`, `run_id`, `started_at`, `ended_at` |

Key Postgres functions (callable via RPC or SQL):
- `character_asset_location_summary()` — aggregate assets per location
- `character_asset_location_contents(parent_id)` — count nested items in a location
- `character_asset_snapshot_at(character_ids[], as_of)` — time-travel asset snapshot as JSON (used by `/api/character/assets`)
- `character_industry_jobs(character_ids[], include_delivered)` — export for Sheets IMPORTDATA (used by `/api/character/jobs`)
- `character_orders(character_ids[])` — export for Sheets IMPORTDATA (used by `/api/character/orders`)
- `corp_assets(character_ids[])` — corp asset snapshot for the caller's corp(s), export for Sheets IMPORTDATA (used by `/api/corp/assets`)
- `corp_industry_jobs(character_ids[], include_delivered)` — corp industry jobs for the caller's corp(s), export for Sheets IMPORTDATA (used by `/api/corp/jobs`)

## Design patterns

- **One extract job per ESI endpoint:** each job in `src/jobs/` pulls exactly one endpoint into its like-named table, sharing the token loops in `src/jobs/lib.js`. Job names double as npm script, queue message `job`, heartbeat label, and workflow file name.
- **SCD Type 2 assets:** `character_asset_over_time` tracks the full history of each item. `is_current=true` rows form the current snapshot. `last_seen_at` is bumped each run for unchanged items; a new row is inserted when anything changes, and the old row's `is_current` is set to `false`. `corp_asset_over_time` (+ `corp_asset` view) mirrors this exact pattern for corp assets, reconciled in `src/jobs/corpAssets.js`.
- **Supabase RLS:** All tables use RLS scoped to `auth.uid()`. Cron scripts use the service-role key (`sudoSupabase` / `src/utils/supabase/service.ts`) which bypasses RLS.
- **Google Sheets IMPORTDATA:** `/api/character/assets`, `/api/character/orders`, `/api/character/jobs`, `/api/corp/assets`, `/api/corp/jobs` authenticate via `user_settings.api_token`, call a Postgres function, and return CSV. The pre-rename paths permanently redirect to the new ones.
- **Vercel queue:** The queue consumer at `/api/queue/jobs` dispatches to the same `run*()` functions the CLI jobs use. The UI enqueues work via `@vercel/queue`.
- **Token lifecycle:** ESI OAuth tokens are stored in `token`. Before any ESI call, `refreshAccessToken()` checks expiry and refreshes via EVE SSO if needed.
- **Name resolution:** `universe_name` table caches ESI `universeNames` lookups (kept fresh by the `universe-names` job). `resolveBatch()` handles bisect-on-error for large batches. Type names (items/ships) come from the locally generated SDE data (`src/sdeTypes.ts`), not the DB.
