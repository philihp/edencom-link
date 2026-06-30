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
- Cron scripts (run via GitHub Actions, see below): `npm run hourly` / `daily` / `assets` / `structures` / `industry-index` / `heartbeat`. `connect`, `ping`, `refresh` are DB/token utilities.
- DB migrations (Supabase CLI, configured by `supabase/config.toml`): `npm run db:new <name>` scaffolds a migration under `supabase/migrations/`; `npm run db:push` applies pending migrations to the linked project (`supabase link --project-ref <ref>` first). On push to `main` that touches `supabase/migrations/**`, the `Migrate` workflow runs `supabase db push` automatically (also manually dispatchable).

## Layout

- `src/app/` — Next.js App Router. Page routes: `account/`, `assets/`, `character/`, `industry/`, `market/`, `structures/`, plus `theme/`, `layout/` (Header/Footer), `private/`. Shared helpers at top level: `typeNames.ts`/`typeName.tsx`, `systemNames.ts`, `stationNames.ts`, `isk.ts`, `DateTime.tsx`.
- `src/` (Node cron/scripts): `esi.js` (ESI API wrapper), `supabase.js` (clients — anon + `sudoSupabase` service role that bypasses RLS), `corpWalletJournal.js`, `corpMarketTransactions.js`, `resolveNames.js`, `structureNames.js`, `tokenRefresh.js`/`refresh.js`, `proxy.ts`, `utils/`. The scheduled job entry points live under `src/jobs/`: `hourly.js`, `daily.js`, `assets.js`, `structures.js` — each exports a `run*` function (callable from the Vercel queue consumer) and self-runs as a CLI when invoked directly (`node src/jobs/<job>.js`).
- `schema.sql` — the single source of truth for the Supabase schema (in the default `public` schema). It's a full reset: it DROPs the app's tables and recreates them, so re-running wipes data — never run it against a database with data you want to keep. To change the schema, edit this file (so a fresh reset stays correct) **and** add a non-destructive incremental migration under `supabase/migrations/` (Supabase CLI format, applied with `supabase db push`) so the change can be rolled out to existing databases without wiping data.
- `.github/workflows/` — `hourly.yml`, `daily.yml`, `assets.yml`, `structures.yml`, `industry_index.yml`, `heartbeat.yml` (each a scheduled cron + manual dispatch); `migrate.yml` (applies Supabase migrations on push to `main`).

## Database & ESI

- DB lives in the default `public` Postgres schema in Supabase (so supabase-js calls need no `.schema()` qualifier). Key tables: `registration`, `token`, `asset_over_time` (SCD type-2: `is_current` + `last_seen_at`), `wallet`, `market_transaction`, `industry_job`, `corp_structure`(+`_rig`), `corp_wallet_journal`, `character_corp`, `eve_name`, `structure`, `user_settings`. RLS enforced; cron uses service-role key.
- ESI base `https://esi.evetech.net/latest` via `src/esi.js`. Tokens (eve-sso OAuth) refreshed per character before fetching.
- **Data flow:** ESI → DB (cron scripts) → Next.js server components read DB. Server components must NOT call ESI directly.
- Env vars (`.env.example`): `EVE_CLIENT_ID`/`EVE_SECRET_KEY`/`EVE_CALLBACK_URL`, `SUPABASE_URL`/`SUPABASE_KEY`/`SUPABASE_SERVICE_KEY`/`SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`, Turnstile keys.

# Workflow

- **Always** `git fetch origin && git rebase origin/main` on the feature branch immediately before pushing and opening a PR. Do this every time, no exceptions — it prevents merge conflicts and avoids PRs that include already-merged changes.

# Data sources

- NEVER query the `evesde` SDE schema in the database. That data is out of date and must not be used for any work. Resolve type/name lookups via `fetchTypeNames` (`src/app/typeNames.ts`), which reads the locally generated SDE data (`src/sdeTypes.ts`), instead. If a needed lookup has no non-SDE source, show the raw ID rather than reading the SDE.

# Architecture

- Data from ESI flows into the database (typically via the hourly cron job in `src/jobs/hourly.js`). The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
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
All functions take `(characterId, accessToken)` unless noted. Returns raw ESI response JSON.
- `assets(characterId, token)` — character assets list
- `transactions(characterId, token)` — market transaction history
- `wallet(characterId, token)` — wallet balance
- `orders(characterId, token)` — open market orders
- `industryJobs(characterId, token)` — industry job list
- `character(characterId, token)` — character sheet
- `corpStructures(corpId, token)` — corporation Upwell structures
- `corpAssets(corpId, token)` — corporation assets
- `corpWalletJournal(corpId, division, token)` — corp wallet journal by division
- `corpTransactions(token, corpId, division)` — corp wallet market transactions for one division
- `assetNames(characterId, token, itemIds[])` — player-assigned names for specific item IDs
- `industrySystems()` — public industry system cost indices (no auth)
- `universeNames(ids[])` — bulk id→name resolution (no auth)
- `universeStructure(structureId, token)` — structure info by ID
- `characterAffiliations(characterIds[])` — bulk character→corp mapping (no auth)

### `src/supabase.js` — Supabase clients and DB helpers
- `supabase` — anon client (respects RLS)
- `sudoSupabase` — service-role client (bypasses RLS; use in cron only)
- `recordHeartbeat(job, runId, runAttempt, runUrl, phase)` — write heartbeat row
- `authenticate(token)` — verify user session token
- `upsertCharacter(characterId, name, ownerId, corporationId)` — insert/update registration row
- `upsertToken(characterId, accessToken, refreshToken, issuedAt, expiresAt, scope[])` — store OAuth tokens
- `upsertAssets(characterId, assets[])` — SCD Type 2 asset upsert
- `selectCharacters(userId)` — registered characters for a user
- `selectCharacterIdsWithScopes(scopes[])` — character IDs that have all listed ESI scopes
- `selectToken(characterId)` — fetch stored token for a character

### `src/tokenRefresh.js`
- `refreshAccessToken(characterId)` — refresh via EVE SSO, update DB, return new token

### `src/resolveNames.js`
- `resolveBatch(ids[])` — bulk ESI `universeNames` with bisect-on-error fallback; upserts to `eve_name`
- `resolveCorpJournalNames(entries[])` — extract and resolve first/second party IDs from journal rows
- `resolveCorpNames(corporationIds[])` — resolve+cache corp names (for labelling corp market sales)
- `resolveCorpStructureSystemNames(structures[])` — resolve system IDs for structures
- `resolveAssetStationNames()` — resolve+cache NPC station names (location_type 'station' in assets) into `eve_name`

### `src/corpMarketTransactions.js`
- `pullCorpMarketTransactions({ access_token, corporation_id, ... })` — fetch all 7 divisions' market transactions, upsert to `corp_market_transaction`

### `src/structureNames.js`
- `resolveStructureNames(structureIds[])` — fetch structure info from ESI using a scoped token, upsert to `structure` table

### `src/corpWalletJournal.js`
- `pullCorpWalletJournals(corpId, token)` — fetch all 7 divisions, upsert to `corp_wallet_journal`

### `src/industryIndexes.js`
- `pullIndustryIndexes()` — fetch public industry cost indices from ESI, insert rows to `industry_system_index` (run by the `industry-index` cron job, `src/jobs/industryIndex.js`)

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
| `/assets` | `src/app/assets/page.tsx` |
| `/assets/[locationId]` | `src/app/assets/[locationId]/page.tsx` |
| `/character` | `src/app/character/page.tsx` |
| `/character/callback` | `src/app/character/callback/page.tsx` |
| `/characters/refresh` | `src/app/characters/refresh/page.tsx` |
| `/market` | `src/app/market/page.tsx` |
| `/industry` | `src/app/industry/page.tsx` |
| `/structures` | `src/app/structures/page.tsx` |
| `/structures/[structureId]` | `src/app/structures/[structureId]/page.tsx` |
| `/settings/grants` | `src/app/settings/grants/page.tsx` |
| `/blueprint` | `src/app/blueprint/page.tsx` |
| `/blueprint/[typeID]` | `src/app/blueprint/[typeID]/page.tsx` |
| `/api/assets` | `src/app/api/assets/route.ts` |
| `/api/orders` | `src/app/api/orders/route.ts` |
| `/api/industry` | `src/app/api/industry/route.ts` |
| `/api/queue/jobs` | `src/app/api/queue/jobs/route.ts` |
| `/api/type/search` | `src/app/api/type/search/route.ts` |

Shared UI helpers: `src/app/isk.ts` (ISK formatting), `src/app/DateTime.tsx`, `src/app/typeName.tsx` (renders a type name from ID), `src/app/typeNames.ts` (resolves type names from the locally generated SDE data), `src/app/systemNames.ts`, `src/app/stationNames.ts`.

## Cron jobs

| npm script | Entry point | GitHub workflow | Schedule |
|---|---|---|---|
| `hourly` | `src/jobs/hourly.js` → `runHourly()` | `hourly.yml` | every hour `:44` |
| `daily` | `src/jobs/daily.js` → `runDaily()` | `daily.yml` | 11:41 UTC |
| `assets` | `src/jobs/assets.js` → `runAssets()` | `assets.yml` | every hour `:26` |
| `structures` | `src/jobs/structures.js` → `runStructures()` | `structures.yml` | 09:17 UTC daily |
| `industry-index` | `src/jobs/industryIndex.js` → `runIndustryIndex()` | `industry_index.yml` | every hour `:10` |
| `heartbeat` | `src/heartbeat.js` | `heartbeat.yml` | 10:55 UTC daily |

Each job exports its `run*()` function and self-invokes as CLI when run directly. The per-character jobs (`assets`, `hourly`, `orders`) plus the account-wide `daily` are also dispatched on demand via the Vercel queue at `/api/queue/jobs` (the "Refresh ESI" flow). `structures` and `industry-index` are cron-only — they do whole-corp/whole-universe work that isn't character-scoped, so they're not fanned out per character.

## Database tables (quick reference)

| Table | Purpose | Notable columns |
|---|---|---|
| `registration` | Linked EVE characters | `character_id`, `user_id`, `name`, `corporation_id` |
| `token` | OAuth tokens | `character_id` (unique FK), `access_token`, `refresh_token`, `expires_at`, `scope[]` |
| `asset_over_time` | SCD Type 2 asset history | `item_id`, `character_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `is_current`, `first_seen_at`, `last_seen_at`, `name` |
| `asset` | View: `is_current` assets | same columns as above |
| `wallet` | Wallet balance history | `character_id`, `balance`, `recorded_at` |
| `market_transaction` | Trade history | `transaction_id`, `character_id`, `type_id`, `unit_price`, `quantity`, `is_buy`, `date` |
| `market_order` | Live open orders | `order_id`, `character_id`, `type_id`, `price`, `volume_remain`, `is_buy`, `seen_at` |
| `industry_job` | Manufacturing/research | `job_id`, `character_id`, `blueprint_id`, `product_type_id`, `activity_id`, `status`, `end_date` |
| `corp_structure` | Corp Upwell structures | `structure_id`, `corporation_id`, `type_id`, `system_id`, `name`, `state`, `fuel_expires`, `services` (jsonb) |
| `corp_structure_rig` | Rigs on structures | `structure_id`, `location_flag`, `type_id`, `corporation_id` |
| `corp_wallet_journal` | Corp transaction log | `corporation_id`, `division`, `entry_id`, `ref_type`, `amount`, `date` |
| `corp_market_transaction` | Corp market buys/sells (unioned into market page) | `transaction_id`, `corporation_id`, `division`, `type_id`, `unit_price`, `quantity`, `is_buy`, `date` |
| `industry_system_index` | Cost index history (append-only) | `system_id`, `activity`, `cost_index`, `recorded_at` |
| `eve_name` | Cached id→name | `id` (bigint PK), `name`, `category` |
| `character_corp` | Character→Corp mapping | `character_id`, `corporation_id` |
| `structure` | Player structure cache | `structure_id`, `name`, `system_id`, `type_id` |
| `user_settings` | User preferences | `user_id`, `enabled_scopes[]`, `api_token` (unique) |
| `invite_code` | Invite-only registration | `code` (unique), `created_by`, `redeemed_by`, `redeemed_at` |
| `refresh_task` | On-demand job tracking | `batch_id`, `user_id`, `job`, `character_id`, `status` (pending/running/done/error) |
| `heartbeat` | Cron job monitoring | `job`, `run_id`, `started_at`, `ended_at` |

Key Postgres functions (callable via RPC or SQL):
- `asset_location_summary()` — aggregate assets per location
- `asset_location_contents(parent_id)` — count nested items in a location
- `asset_snapshot_at(character_ids[], as_of)` — time-travel asset snapshot as JSON (used by `/api/assets`)
- `industry_jobs(character_ids[])` — export for Sheets IMPORTDATA
- `market_orders(character_ids[])` — export for Sheets IMPORTDATA

## Design patterns

- **SCD Type 2 assets:** `asset_over_time` tracks the full history of each item. `is_current=true` rows form the current snapshot. `last_seen_at` is bumped each run for unchanged items; a new row is inserted when anything changes, and the old row's `is_current` is set to `false`.
- **Supabase RLS:** All tables use RLS scoped to `auth.uid()`. Cron scripts use the service-role key (`sudoSupabase` / `src/utils/supabase/service.ts`) which bypasses RLS.
- **Google Sheets IMPORTDATA:** `/api/assets`, `/api/orders`, `/api/industry` authenticate via `user_settings.api_token`, call a Postgres function, and return CSV.
- **Vercel queue:** The queue consumer at `/api/queue/jobs` dispatches to the same `run*()` functions the CLI jobs use. The UI enqueues work via `@vercel/queue`.
- **Token lifecycle:** ESI OAuth tokens are stored in `token`. Before any ESI call, `refreshAccessToken()` checks expiry and refreshes via EVE SSO if needed.
- **Name resolution:** `eve_name` table caches ESI `universeNames` lookups. `resolveBatch()` handles bisect-on-error for large batches. Type names (items/ships) come from the locally generated SDE data (`src/sdeTypes.ts`), not the DB.
