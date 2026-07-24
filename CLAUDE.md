# Project overview

EVE Online hangar/wallet/industry tracker. Package name `edencom-link` (private). Deployed on Vercel.

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript 6, ESM (`"type": "module"`). Supabase (Postgres) for storage. `ramda` for utilities.
- **Node:** 24.18.0 (`.node-version`). **Package manager:** pnpm (`pnpm-lock.yaml`; version pinned by the `packageManager` field in `package.json`, set up in CI via `pnpm/action-setup`).
- **Path alias:** `@/*` → `./src/*`.

## Commands

- `pnpm run dev` — Next dev server (default port 3000).
- `pnpm run build` / `pnpm start` — production build / serve.
- `pnpm run lint` — `eslint .` (flat config `eslint.config.mjs`; `no-explicit-any` is off, unused vars allowed with `^_` prefix).
- `pnpm run pretty` — `prettier --write src/` (config: `@philihp/prettier-config`).
- **No test runner / no `test` script** — there are no automated tests. No `typecheck` script (rely on `next build` / editor).
- Pre-commit: husky + lint-staged auto-format & `eslint --fix` staged files.
- **The build downloads nothing from CCP, and no longer touches the SDE at all.** SDE type/system/station/blueprint/planet lookups read the nightly-mirrored `sde_*` tables at runtime via the async loaders in `src/sde*.ts` (SDE-to-database cutover; the old `sde:build`/`src/buildSde.js` build-time JSON generator was removed). The ship-fitting protobufs used to be built at `predev`/`prebuild` time by `esf:build`, but that step was removed too — they're now encoded by the nightly `sde-mirror` workflow (as a tail step of that job, started once its 7 input tables have landed) into the `esf_data` table and served at `/esf/[file]` (see `esf-data` below). There are no `predev`/`prebuild` steps.
- `pnpm run esf-data` — encodes the 6 `@eveshipfit/react` protobuf files (`types.pb2`/…) from the nightly-mirrored `sde_*` tables (public-read anon key; needs `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`) per `src/esf.proto`, and base64-upserts them into the `esf_data` table via the service role (`src/jobs/esfData.js` → `encodeEsfData()` in `src/buildEsfData.js`). Not separately scheduled: it runs as the tail of the `sde-mirror` workflow on every pass (`encodeEsf` step, including the build-unchanged skip path); idempotent (a cheap no-op when `esf_data` is already at the current build). Also runnable manually — the CLI, or the unscheduled `CRON_SECRET`-protected `/api/cron/esf-data` route (bootstrap / `?force=1`). The `/esf/[file]` route serves the rows; the old build-time `public/esf-data/*.pb2` static files are gone.
- `pnpm run sde-mirror` — mirrors CCP's full SDE (every JSONL file in the export) into the `public` schema's `sde_*` tables, plus ESI-resolved NPC station names into `sde_npc_station_name` (`--force` to re-ingest the current build). In production this runs nightly at 12:21 UTC as a Vercel Workflow (see the Extract jobs section). See `src/jobs/sdeMirror.js`.
- **Vendored `@eveshipfit/*` packages:** `@eveshipfit/react` and `@eveshipfit/dogma-engine` are published to GitHub Packages (`npm.pkg.github.com`), which needs a `read:packages` token to install — a per-build auth dependency we removed by committing the published tarballs under `vendor/eveshipfit/` and referencing them via `file:` specifiers in `package.json` (so `pnpm install` needs no token or `NPM_RC`). `@eveshipfit/data` is *not* vendored: react only imports one constant from it (`ESF_DATA_VERSION`, for a default data URL we override via `dataUrl="/esf-data/"`), so it's replaced by the tiny local stub `vendor/eveshipfit/data-stub/`. To bump a package: `npm pack @eveshipfit/<pkg>@<version>` (needs your own token), drop the `.tgz` into `vendor/eveshipfit/`, update its `file:` path in `package.json`, and `pnpm install`. Releases are rare (dogma-engine last shipped mid-2025; react ~once/year), so this is near-zero maintenance.
- Extract job scripts (one per ESI endpoint, scheduled via Vercel Cron, see below): `pnpm run character-assets` / `character-blueprints` / `character-orders` / `character-wallet` / `character-wallet-transactions` / `character-industry-jobs` / `character-mercenary-dens` / `character-location` / `character-clones` / `character-implants` / `character-ship` / `character-skills` / `character-status` (combined wallet+location+implants+clones+ship+skills) / `character-directory` / `corp-structures` / `corp-assets` / `corp-blueprints` / `corp-wallet-journal` / `corp-wallet-transactions` / `corp-industry-jobs` / `industry-systems` / `universe-names` / `universe-structures`, plus `heartbeat`. `connect`, `ping`, `refresh` are DB/token utilities.
- DB migrations (Supabase CLI, configured by `supabase/config.toml`): `pnpm run db:new <name>` scaffolds a migration under `supabase/migrations/`; `pnpm run db:push` applies pending migrations to the linked project (`supabase link --project-ref <ref>` first). On push to `main` that touches `supabase/migrations/**`, the `Migrate` workflow runs `supabase db push` automatically (also manually dispatchable).

## Layout

- `src/app/` — Next.js App Router. Page routes: `account/`, `asset/`, `blueprint/`, `character/`, `corpses/`, `indexes/`, `industry/`, `market/`, `mercenary-dens/`, `ship/` (a ship's own page: eveship.fit wheel + stats, owner/location, share links; `/asset/[id]` redirects ships here), `structure/`, `settings/`, `oauth/`, `xrpc/`, plus `layout/` (Header/Footer), `error/`, `private/`. Shared helpers at top level: `typeNames.ts`/`typeName.tsx`, `systemNames.ts`, `stationNames.ts`, `isk.ts`, `DateTime.tsx`, `names.tsx`, `assetPath.tsx` (see the routes section).
- `src/` (Node cron/scripts): `esi.js` (ESI API wrapper), `supabase.js` (clients — anon + `sudoSupabase` service role that bypasses RLS), `resolveNames.js`, `tokenRefresh.js`/`refresh.js`, `proxy.ts`, `utils/`. The extract jobs live under `src/jobs/` — one file per ESI endpoint (`characterAssets.js`, `corpStructures.js`, …) plus the shared plumbing in `src/jobs/lib.js` (`forEachCharacter`/`forEachCorporation` token loops, `fetchAllPages`, `forEachSequential`, `cli`). Each job exports a `run*` function (callable from the Vercel queue consumer) and self-runs as a CLI when invoked directly (`node src/jobs/<job>.js`).
- `schema.sql` — the single source of truth for the Supabase schema (in the default `public` schema). It's a full reset: it DROPs the app's tables and recreates them, so re-running wipes data — never run it against a database with data you want to keep. To change the schema, edit this file (so a fresh reset stays correct) **and** add a non-destructive incremental migration under `supabase/migrations/` (Supabase CLI format, applied with `supabase db push`) so the change can be rolled out to existing databases without wiping data.
- `.github/workflows/` — `heartbeat.yml` (daily canary; still GitHub Actions since it's specifically a canary for scheduled-trigger health, not an ESI extract); `migrate.yml` (applies Supabase migrations on push to `main`); `bump-eveshipfit.yml` (Mondays 08:00 UTC; Renovate can't track the vendored `file:` tarballs, so this checks GitHub Packages for newer `@eveshipfit/react`/`@eveshipfit/dogma-engine`, re-packs into `vendor/eveshipfit/`, and opens/updates a PR — see `.github/scripts/bump-eveshipfit.mjs`). All ESI extract jobs used to have a like-named workflow here but have moved to Vercel Cron (see `src/app/api/cron/`) since the GitHub Actions schedule wasn't firing reliably.

## Database & ESI

- DB lives in the default `public` Postgres schema in Supabase (so supabase-js calls need no `.schema()` qualifier). Extract tables are named after the ESI endpoint that feeds them, prefixed by owner scope: `character_*`, `corp_*`, `universe_*` (see the table reference below). RLS enforced; cron uses service-role key.
- ESI base `https://esi.evetech.net/latest` via `src/esi.js`. Tokens (eve-sso OAuth) refreshed per character before fetching.
- **Data flow:** ESI → DB (extract jobs) → Next.js server components read DB. Server components must NOT call ESI directly.
- Env vars (`.env.example`): `EVE_CLIENT_ID`/`EVE_SECRET_KEY`/`EVE_CALLBACK_URL`, `SUPABASE_URL`/`SUPABASE_KEY`/`SUPABASE_SERVICE_KEY`/`SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`, Turnstile keys.

# Workflow

- **Always** `git fetch origin && git rebase origin/main` on the feature branch immediately before pushing and opening a PR. Do this every time, no exceptions — it prevents merge conflicts and avoids PRs that include already-merged changes.
- **Never rename an existing file under `supabase/migrations/`.** Once a migration file exists, its filename is its identity to the Supabase CLI and to every environment that may have already applied it — renaming it (even to fix ordering) desyncs whichever environment (local, CI, production) isn't looking at the exact commit you renamed it on, since the migration history table matches by filename/version, not content. This happened for real: a migration timestamp ordering bug got "fixed" by renaming files across several PRs (#614/#615/#616), and each rename just relocated the mismatch between local, CI, and the already-applied remote history — repeatedly breaking `supabase db push` in new ways instead of fixing it. I was a bad Claude for doing that, it was an amateur mistake, and I deeply regret it. If a migration's ordering or content is wrong, add a **new** migration file with a fresh timestamp instead of touching the old one.

# Data sources

- The legacy `evesde` DB schema has been dropped (stale out-of-band data) — do not recreate or reference it. SDE lookups go through the `src/sde*.ts` loaders. If a needed lookup has no non-SDE source, show the raw ID rather than reading the SDE.

# Architecture

- Data from ESI flows into the database via the per-endpoint extract jobs in `src/jobs/`. The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
- Type/group/category (and system/station/blueprint/planet) lookups are resolved at runtime from the nightly-mirrored `sde_*` tables/views (`sde_published_type`, `sde_kspace_system`, `sde_station`, `sde_planet`, `sde_blueprint_product`, the taxonomy/universe views `sde_group`/`sde_category`/`sde_region` — see `supabase/migrations/20260723000000_sde_taxonomy_views.sql` — and the `sde_search_type`/`sde_search_system` RPCs — see `supabase/migrations/20260716010000_sde_mirror.sql`), populated by the `sde-mirror` Vercel Workflow from CCP's official Static Data Export (`developers.eveonline.com/static-data`, JSONL — never Fuzzwork's third-party mirror, which is off-limits). The async loaders in `src/sde*.ts` query these through the public-read anon client `src/utils/supabase/sde.ts`, caching by-id lookups per server process for 6h (misses never cached; shared cache in `src/sdeCache.ts`). `src/sdeTypes.ts` exposes `getSdeType`/`getSdeTypes`/`getSdeTypeNames`/`searchSdeTypes`/`searchSdeTypesAll`, used by `src/app/typeNames.ts`, `src/app/blueprint/api.ts`, and `src/app/api/type/search/route.ts`. The `esf-data` cron/workflow job (`src/jobs/esfData.js` → `encodeEsfData()` in `src/buildEsfData.js`) reads the same `sde_*` mirror to encode the ship-fitting protobufs into the `esf_data` table — this is no longer a build step, so **the build touches no SDE at all**. If a needed field isn't in a view, extend the view in `src/jobs/sdeMirror.js` + a migration.

# Codebase map

Quick-reference for navigation. Covers key exports, route→file paths, DB tables, and design patterns.

## Key source file exports

### `src/buildEsfData.js` — ship-fitting protobuf encoder (`encodeEsfData()`, no longer a build step)
- Exports `encodeEsfData()`: reads the 6 `@eveshipfit/react` protobuf inputs (types/groups/categories/marketGroups/dogmaAttributes/dogmaEffects/typeDogma) from the nightly-mirrored `sde_*` tables via the public-read anon key — no CCP download, no `unzip` binary — pages each `sde_<stem>` table 1000 rows at a time and consumes each row's `data` jsonb (the raw SDE object), applies the vendored eveship.fit dogma patches (`src/esfPatches.json`), encodes per `src/esf.proto`, and returns `{ [fileName]: Buffer }` without touching disk. Also exports `ESF_FILE_NAMES`. Needs `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`. This module no longer runs at build time (the `esf:build` `predev`/`prebuild` step and its `public/esf-data/*.pb2` output were removed); `encodeEsfData()` is called only by `src/jobs/esfData.js` (`pnpm run esf-data`, `runEsfData()`), which base64-upserts the 6 files into the `esf_data` table — run as the final step (`encodeEsf`) of the `sde-mirror` workflow on every pass — and the `/esf/[file]` route serves those rows. Full history in `docs/sde-db-cutover/04-esf-workflow.md` (Transform → Serve → Contract, all done).

### `src/sdeTypes.ts` (async; DB-backed over `sde_published_type` + `sde_search_type` — SDE cutover PR 5)
- `getSdeTypes(typeIDs[])` — bulk id→`{ typeID, name, groupID, categoryID }`, cached per process (see `src/sdeCache.ts`)
- `getSdeType(typeID)` — single lookup (via `getSdeTypes`), or `null`
- `getSdeTypeNames(typeIDs[])` — bulk id→name lookup
- `searchSdeTypesAll(query)` — case-insensitive substring search over every published type name, ranked by match coverage, capped at 1000 rows (RPC max — every "too many types" guard triggers far below that). `SdeSearchResult` carries `categoryID`, so category filtering needs no per-row `getSdeType`
- `searchSdeTypes(query, limit?)` — same search capped to `limit` results, for autocomplete UIs

### `src/sdeSystems.ts` (async; DB-backed over `sde_kspace_system` + `sde_search_system` — SDE cutover PR 3)
- `getSdeSystems(systemIDs[])` — bulk id→`{ systemID, name, security }`, cached per process (see `src/sdeCache.ts`)
- `getSdeSystem(systemID)` — single lookup, or `null`
- `getSdeSystemNames(systemIDs[])` — bulk id→name lookup
- `searchSdeSystems(query, limit?)` — case-insensitive substring search over system names via the `sde_search_system` RPC (backs the /indexes watch-a-system autocomplete)
- `formatSecurity(security)` — one-decimal display rounding (sync, pure)

### `src/sdeStations.ts` (async; DB-backed over the `sde_station` view — SDE cutover PR 1)
- `getSdeStations(stationIDs[])` — bulk id→`{ stationID, name, systemID }`, cached per process (see `src/sdeCache.ts`)
- `getSdeStation(stationID)` — single lookup, or `null`
- `getSdeStationNames(stationIDs[])` — bulk id→name lookup
- `getSdeStationSystems(stationIDs[])` — bulk id→solar-system-id lookup (the SDE carries this directly; ESI's `universe/names` never did)

### `src/sdePlanets.ts` (async; DB-backed over the `sde_planet` view — SDE cutover PR 2)
- `getSdePlanets(planetIDs[])` — bulk id→`{ planetID, systemID, systemName, celestialIndex, typeID, roman, name }`, cached per process. `name` is derived as `"<system> <roman(celestialIndex)>"` (e.g. `RXA-W1 III`) — the same key the hand-maintained mercenary-den intel uses. No longer depends on `sdeSystems` (the view carries `system_name`)
- `getSdePlanet(planetID)` — single lookup, or `null`
- `toRoman(n)` — celestial-index → roman numeral (sync, pure); `TEMPERATE_PLANET_TYPE_ID` (11) constant
- Backs the `/mercenary-dens` page, which resolves each den's `planet_id` to a system + roman to union real dens with the static temperate-planet list

### `src/sdeBlueprints.ts` (async; DB-backed over the `sde_blueprint_product` materialized view — SDE cutover PR 4)
- `getBlueprintForProduct(productTypeID)` — the manufacturing/reaction `Blueprint` that produces a given output (manufacturing preferred over reaction), or `null`
- `getBlueprintsForMaterial(materialTypeID)` — every `Blueprint` that consumes a given type as an input material (via a `@>` containment probe on the GIN-indexed `materials` jsonb)
- `Blueprint` = `{ blueprintTypeID, activityID, productTypeID, productQuantity, materials: [{ typeID, quantity }] }`; `MANUFACTURING`/`REACTION` activity-id constants. Not cached (low-volume paths). Backs the MCP `blueprint_for_product` / `blueprints_using_material` tools.

### `src/esi.js` — ESI API wrapper
All functions take `(accessToken, id, ...)` unless noted. Returns raw ESI response JSON (paged wrappers return `[json, xPagesHeader]`).
- `assets(token, characterId, page)` — character assets list (paged)
- `blueprints(token, characterId, page)` — character blueprints list (paged)
- `transactions(token, characterId)` — market transaction history
- `wallet(token, characterId)` — wallet balance
- `orders(token, characterId)` — open market orders
- `industryJobs(token, characterId)` — industry job list
- `character(token, characterId)` — character sheet
- `characterLocation(token, characterId)` — current solar system (and station/structure, if docked)
- `characterClones(token, characterId)` — home clone + jump clones, each with location and (for jump clones) implants, plus `last_clone_jump_date`/`last_station_change_date`
- `characterImplants(token, characterId)` — implants currently plugged into whichever clone body the character occupies
- `characterShip(token, characterId)` — the ship the character is currently in (docked or not): `{ ship_item_id, ship_name, ship_type_id }`
- `characterMercenaryDens(token, characterId)` — the character's deployed Mercenary Dens: `{ mercenary_dens: [{ id, planet_id }] }`. Uses the newer compatibility-date ESI (kebab-case path, `X-Compatibility-Date` header, Bearer auth — `esiCompatJson`), not the legacy `/latest` base.
- `characterMercenaryDen(token, characterId, denId)` — one den's live status: `{ id, type_id, state, evolution: { development, anarchy }, infomorphs, reinforcement_timer, skyhook }` (compatibility-date endpoint)
- `corpStructures(token, corpId, page)` — corporation Upwell structures (paged)
- `corpAssets(token, corpId, page)` — corporation assets (paged)
- `corpBlueprints(token, corpId, page)` — corporation blueprints list (paged)
- `corpIndustryJobs(token, corpId, page)` — corporation industry jobs (paged)
- `corpWalletJournal(token, corpId, division, page)` — corp wallet journal by division (paged)
- `corpTransactions(token, corpId, division)` — corp wallet market transactions for one division
- `assetNames(token, characterId, itemIds[])` — player-assigned names for specific item IDs
- `industrySystems()` — public industry system cost indices (no auth)
- `universeNames(ids[])` — bulk id→name resolution (no auth)
- `universeStructure(token, structureId)` — structure info by ID
- `universeStation(stationId)` — NPC station info by ID (no auth; used to place clones in a solar system)
- `characterAffiliations(characterIds[])` — bulk character→corp mapping (no auth)

### `src/jobs/lib.js` — shared extract-job plumbing
- `forEachCharacter(tag, { scope, characterIds, heartbeat = true }, handler)` — iterate tokens carrying an ESI scope, refresh each, call handler with `{ access_token, characterID, character_id, userId, name, ctx, scopes }` (`scopes` is the token's fresh scope list). Wraps each call in a start/end `heartbeat` row attributed to that character (`character_id`/`user_id`) unless `heartbeat: false` (forEachCorporation passes this to avoid a redundant row)
- `forEachCharacterAnyScope(tag, { scopes, characterIds, heartbeat = true }, handler)` — like `forEachCharacter` but selects tokens carrying **any** of `scopes` (array overlap) rather than one required scope, for a job fronting several endpoints with different scopes (`character-status`); the handler reads `scopes` to run only the endpoints the token is authorized for
- `forEachCorporation(tag, { scope, characterIds }, handler)` — same, deduped to one handler call per corporation; also keeps `registration.corporation_id` fresh (corp-table RLS keys off it). Wraps each call in its own start/end `heartbeat` row attributed to the corp and the character whose token authorized the pull (`corporation_id`/`character_id`/`user_id`)
- `fetchAllPages(fetchPage)` — drain an x-pages-paginated ESI endpoint
- `forEachSequential(items, fn)` — the jobs' ramda-based stand-in for `for (const x of items) { await fn(x) }`; runs `fn` once per item in order, awaiting each before the next
- `cli(import.meta.url, tag, run)` — self-run a job module when invoked directly as a CLI

### `src/supabase.js` — Supabase clients and DB helpers
- `supabase` — anon client (respects RLS)
- `sudoSupabase` — service-role client (bypasses RLS; use in cron only)
- `recordHeartbeat(job, phase, opts)` — write a heartbeat row; `opts.characterId`/`corporationId`/`userId` attribute it to the entity a per-character/per-corp job ran for (omit for whole-job/account-wide runs). The start/end pair upserts onto one row keyed on `job, run_id, run_attempt, owner_key` — `owner_key` is a generated column folding `character_id`/`corporation_id` into a single non-null discriminator so per-entity rows within the same run pair correctly instead of collapsing onto each other
- `authenticate()` — sign the anon client in via `SUPABASE_USERNAME`/`SUPABASE_PASSWORD` env vars (CLI utility scripts)
- `upsertCharacter(characterId, name, ownerId, corporationId)` — insert/update registration row
- `upsertToken(characterId, accessToken, refreshToken, issuedAt, expiresAt, scope[])` — store OAuth tokens
- `upsertAssets(characterId, assets[])` — asset upsert (legacy `refresh.js` utility)
- `selectCharacters(columns, owner?)` — registration rows (given select-column list), optionally filtered by `owner`
- `selectCharacterIdsWithScopes(scopes[])` — character IDs that have all listed ESI scopes
- `groupCharacterIdsByCorporation(scopes)` — `{ byCorp, unresolved }`: scoped character ids grouped by corporation, for the per-corporation job fan-out
- `selectToken(characterId, scope?[])` — fetch stored token for a character, optionally requiring scopes
- `getEsiEtag(cacheKey)` / `putEsiEtag(cacheKey, etag)` — read/store the last ESI ETag for a conditional-request cache key (`esi_etag` table); both are best-effort (a DB failure degrades to an unconditional fetch rather than throwing). Used by the single-request snapshot jobs (`character-orders`/`-wallet-transactions`/`-industry-jobs`) to send `If-None-Match` and skip re-processing on a `304`

### `src/tokenRefresh.js`
- `refreshAccessToken(tokenRow)` — refresh via EVE SSO, update DB, return new token

### `src/resolveNames.js`
- `resolveBatch(ids[])` / `resolveAllIds(ids[])` — bulk ESI `universeNames` with bisect-on-error fallback
- `resolveCorpJournalNames()` — resolve first/second party IDs seen in corp wallet journal rows into `universe_name`
- `resolveKnownCorpNames()` — resolve+cache corp names seen in `corp_wallet_transaction`/`character_affiliation`/`corp_structure`
- `resolveCorpIndustryJobInstallerNames()` — resolve+cache the character name of every `corp_industry_job.installer_id` (whichever corp member ran the job, not necessarily one of this app's linked characters)
- `resolveCorpStructureSystemNames()` — resolve system IDs for corp structures
- `resolveAssetStationNames()` — resolve+cache NPC station names (location_type 'station' in assets) into `universe_name`
- `resolveAssetSystemNames()` — resolve+cache solar system names for assets floating directly in space (location_type 'solar_system') into `universe_name`

### `src/utils/apiToken.ts`
- `resolvePlayer(token: string)` — look up `user_settings.api_token` for Sheets API endpoints; returns `{ ok: true, supabase, characterIds }` or `{ ok: false, status, error }`

### `src/utils/csv.ts`
- `toCsv(rows: object[])` — serialize flat object array to RFC 4180 CSV string

### `src/utils/atParam.ts`
- `parseAtParam(raw)` — parse the optional `at=` time-travel query param on the snapshot API endpoints (pads partial ISO dates) → `{ ok: true, iso }` | `{ ok: false }`; `AT_PARAM_ERROR` is the invalid-`at` hint string

### `src/utils/queue.ts`
- `queue` — region-pinned `@vercel/queue` `QueueClient` (default `sfo1`, override via `QUEUE_REGION`), plus its destructured `send` / `handleCallback`

### `src/utils/cron.ts`
- `requireCronSecret(request)` plus the four cron dispatch shapes: `fanOutPerCharacterCronJob`, `fanOutPerCharacterAnyScopeCronJob`, `fanOutPerCorporationCronJob`, `dispatchAccountCronJob`, `runDirectCronJob` (see the Extract jobs section)

### `src/utils/supabase/client.ts` / `server.ts` / `service.ts` / `bearer.ts` / `sde.ts`
- Browser / server-cookie / service-role / OAuth-bearer-token Supabase client factories (`bearer.ts` builds an RLS-scoped client from an MCP caller's access token). `sde.ts` is a lazy module-level **anon** client for the public-read `sde_*` mirror tables — used by the `src/sde*.ts` loaders in every context (server components, route handlers, MCP tools, anonymous share pages) without cookie/bearer plumbing; never used for writes (the build-time `src/buildEsfData.js` uses its own inline anon client for the same tables)

## App routes → files

| URL path | File |
|---|---|
| `/` | `src/app/page.tsx` |
| `/account/login` | `src/app/account/login/page.tsx` |
| `/account/register` | `src/app/account/register/page.tsx` |
| `/account/settings` | `src/app/account/settings/page.tsx` |
| `/account/invite` | `src/app/account/invite/page.tsx` |
| `/account/reset` | `src/app/account/reset/page.tsx` |
| `/account/confirm` | `src/app/account/confirm/route.ts` |
| `/account/debug` | `src/app/account/debug/page.tsx` |
| `/account/chancellor` | `src/app/account/chancellor/page.tsx` |
| `/asset` | `src/app/asset/page.tsx` |
| `/asset/[locationId]` | `src/app/asset/[locationId]/page.tsx` |
| `/asset/search` | `src/app/asset/search/page.tsx` |
| `/ship/[itemId]` | `src/app/ship/[itemId]/page.tsx` |
| `/character` | `src/app/character/page.tsx` |
| `/character/callback` | `src/app/character/callback/route.ts` |
| `/character/refresh` | `src/app/character/refresh/page.tsx` |
| `/market` | `src/app/market/page.tsx` |
| `/industry` | `src/app/industry/page.tsx` |
| `/indexes` | `src/app/indexes/page.tsx` |
| `/mercenary-dens` | `src/app/mercenary-dens/page.tsx` |
| `/corpses/[characterID]` | `src/app/corpses/[characterID]/page.tsx` |
| `/structure` | `src/app/structure/page.tsx` |
| `/structure/revenue` | `src/app/structure/revenue/page.tsx` |
| `/structure/[structureId]` | `src/app/structure/[structureId]/page.tsx` |
| `/settings/grants` | `src/app/settings/grants/page.tsx` |
| `/blueprint` | `src/app/blueprint/page.tsx` |
| `/blueprint/[typeID]` | `src/app/blueprint/[typeID]/page.tsx` |
| `/oauth/consent` | `src/app/oauth/consent/page.tsx` |
| `/esf/[file]` | `src/app/esf/[file]/route.ts` |
| `/api/mcp` | `src/app/api/mcp/route.ts` |
| `/.well-known/oauth-protected-resource` | `src/app/.well-known/oauth-protected-resource/[[...resource]]/route.ts` |
| `/api/character/assets` | `src/app/api/character/assets/route.ts` |
| `/api/character/blueprints` | `src/app/api/character/blueprints/route.ts` |
| `/api/character/orders` | `src/app/api/character/orders/route.ts` |
| `/api/character/jobs` | `src/app/api/character/jobs/route.ts` |
| `/api/corp/assets` | `src/app/api/corp/assets/route.ts` |
| `/api/corp/blueprints` | `src/app/api/corp/blueprints/route.ts` |
| `/api/corp/jobs` | `src/app/api/corp/jobs/route.ts` |
| `/api/queue/jobs` | `src/app/api/queue/jobs/route.ts` |
| `/api/type/search` | `src/app/api/type/search/route.ts` |
| `/xrpc/[method]` | `src/app/xrpc/[method]/route.ts` |

Notable pages:
- `/mercenary-dens` — unions the DB's extracted dens (own + corp-shared via RLS) with hand-maintained intel in `src/app/mercenary-dens/data.ts` (`STAGING`, `LINKS` system adjacency, `TEMPERATE_PLANETS`, per-planet `den` ownership — the volatile, hand-edited part), rendered as a server-side SVG topology (`topology.tsx`, red reinforced > green ours > yellow external) plus a table; `shareCorps.tsx` manages den sharing to corps.
- `/corpses/[characterID]` — public share page (no login; resolves for any registered character). Reads via the service-role client explicitly scoped to the owning account's registrations; lists corpse-type items from `character_asset`, deriving the dead pilot's name from the asset name (`"<pilot>'s Frozen Corpse"`), with a "New!" badge for corpses first seen within 48h (`valid_from`).
- `/structure/revenue` — corp industry-job-tax revenue (`corp_wallet_journal` `ref_type='industry_job_tax'`) grouped by UTC day with a day pager; pages past PostgREST's 1000-row cap via range paging.
- `/account/chancellor` — admin page for Chancellor accounts (an account that redeemed an `invite_code` with `is_chancellor=true`; `isChancellor()` in `src/app/account/chancellor/chancellor.ts` checks via the service role). Grants/revokes Chancellor status via invite codes.
- `/account/debug` — dumps the signed-in user's settings (scopes, api_token, flags); `/account/confirm` handles Supabase email-OTP confirm links; `/account/reset` is password reset; `/error` is the generic error page.
- `/xrpc/[method]` — edge-runtime stub answering AT Protocol XRPC calls with a 404 JSON body; the domain used to run an ATProto PDS and decommissioned-relay crawlers still poll it. Deliberately minimal to reject bot noise cheaply (404, not 5xx, to keep Vercel logs clean).

The old CSV endpoint paths (`/api/assets`, `/api/orders`, `/api/industry`) and `/characters/refresh` permanently redirect to their new homes (see `next.config.mjs`) so existing Google Sheets keep working; `/asset/:itemId/fit` temporarily redirects to `/ship/:itemId`. `next.config.mjs` also sets `turbopack: {}` (WASM handling for `@eveshipfit/dogma-engine`) and injects build-time `BUILD_TIME`/`COMMIT_SHA` env vars.

Shared UI helpers: `src/app/isk.ts` (ISK formatting), `src/app/DateTime.tsx`, `src/app/typeName.tsx` (renders a type name from ID), `src/app/typeNames.ts` (resolves type names from the locally generated SDE data), `src/app/systemNames.ts`, `src/app/stationNames.ts`, `src/app/names.tsx` (`Name`/`CharacterName`/`SystemName`/`StationName` — thin serif-face wrappers for dynamic entity names with `#id` / `—` fallbacks), `src/app/assetPath.tsx` (the breadcrumb of where an item lives on `/asset/[locationId]` and `/ship/[itemId]`, fed by the `asset_ancestors()` Postgres function), `src/app/owners.ts` / `src/app/ownerFilter.tsx` (the character/corp "owner" picker shared by the assets and industry pages), `src/app/resolveLocations.ts` (resolves a set of root locations — station, player structure, or bare solar system — to display names + systems; shared by `/asset` and `/asset/search`; it and `owners.ts`/`systemNames.ts`/`stationNames.ts` accept an optional Supabase client so the MCP tools can reuse them with a bearer-token client instead of the cookie session), `src/app/freshness.ts` / `src/app/Freshness.tsx` (data-freshness grading — green under 15 minutes, yellow under 75, red beyond — and the live dot + "N minutes ago" client component; used by the header's "Refreshed …" indicator and the `/character/refresh` matrix).

## Extract jobs

One job per ESI endpoint. The npm script, queue job name, and heartbeat job label all share the job's name; the entry point is the camelCased file under `src/jobs/` exporting `run<PascalCase>()` (e.g. `character-assets` → `src/jobs/characterAssets.js` → `runCharacterAssets()`). Every job is scheduled by a like-named Vercel Cron entry (`vercel.json`'s `crons` + `src/app/api/cron/<job>/route.ts`) rather than GitHub Actions, which wasn't firing reliably every hour.

| Job | ESI endpoint | Writes to | Schedule (UTC) |
|---|---|---|---|
| `character-assets` | `/characters/{id}/assets/` (+`/assets/names/`) | `character_asset_over_time` | every 6h `:26` |
| `character-blueprints` | `/characters/{id}/blueprints/` | `character_blueprint_over_time` | every 6h `:28` |
| `character-orders` | `/characters/{id}/orders/` | `character_order_over_time` | every 6h `:24` |
| `character-wallet-transactions` | `/characters/{id}/wallet/transactions/` | `character_wallet_transaction` | every 6h `:46` |
| `character-industry-jobs` | `/characters/{id}/industry/jobs/` | `character_industry_job_over_time` | every 6h `:48` |
| `character-mercenary-dens` | `/characters/{id}/structures/mercenary-dens/` (+ per-den detail) | `character_mercenary_den_over_time` (SCD identity), `character_mercenary_den_status` (append-only observations) | every 6h `:30` |
| `character-status` | `/characters/{id}/wallet/` + `/location/` + `/implants/` + `/clones/` + `/ship/` + `/skills/` | `character_wallet`, `character_location`, `character_implant`, `character_clone_over_time`, `character_clone_state`, `character_ship`, `character_skill_over_time` | every 6h `:14` |
| `character-directory` | `/characters/affiliation/` (+ `/universe/names/`) | `character_directory`, `corporation`, `alliance`, `character_affiliation`, `registration` (corporation_id) | 11:41 daily |
| `corp-structures` | `/corporations/{id}/structures/` | `corp_structure` | 09:17 daily |
| `corp-assets` | `/corporations/{id}/assets/` | `corp_asset_over_time`, `corp_structure_rig` | 09:27 daily |
| `corp-blueprints` | `/corporations/{id}/blueprints/` | `corp_blueprint_over_time` | 09:07 daily |
| `corp-wallet-journal` | `/corporations/{id}/wallets/{division}/journal/` | `corp_wallet_journal` | every 6h `:37` |
| `corp-wallet-transactions` | `/corporations/{id}/wallets/{division}/transactions/` | `corp_wallet_transaction` | every 6h `:50` |
| `corp-industry-jobs` | `/corporations/{id}/industry/jobs/` | `corp_industry_job_over_time` | every 6h `:47` |
| `industry-systems` | `/industry/systems/` | `industry_system_index` (systems with structures ∪ user-watched systems) | every 6h `:10` |
| `universe-names` | `/universe/names/` | `universe_name` | every 6h `:58` |
| `universe-structures` | `/universe/structures/{id}` | `universe_structure` | 09:57 daily |
| `sde-mirror` | CCP SDE zip (`developers.eveonline.com/static-data`) + ESI `/universe/names/` | `sde_*` mirror tables, `sde_npc_station_name`, `sde_mirror_state` | 12:21 daily |

`character-status` (`src/jobs/characterStatus.js`) is the one exception to "one job per ESI endpoint": it folds the six cheap live-state per-character pulls (wallet, location, implants, clones, current ship, skills) into a single extract so they share one Vercel function invocation per character instead of six, to cut per-invocation cost. It writes to each endpoint's original table, keeps their separate ESI scopes (a character runs only the endpoints its token carries — via `forEachCharacterAnyScope` in `src/jobs/lib.js`, which selects tokens overlapping any of the scopes and hands the handler the token's scope list), and fault-isolates each endpoint so one failing doesn't abort the others. The individual `character-wallet`/`character-location`/`character-implants`/`character-clones`/`character-ship`/`character-skills` job modules still exist and run standalone via CLI (`node src/jobs/<job>.js`) and the queue — each exports a reusable `sync*` per-character helper that `characterStatus.js` calls — but only `character-status` is scheduled (Vercel Cron) and shown on `/character/refresh`.

`src/heartbeat.js` (`heartbeat.yml`, 10:55 daily) is a canary that just proves heartbeat recording works; it remains on GitHub Actions since it isn't an ESI extract job.

The per-character jobs (`PER_CHARACTER_JOBS` in `src/app/character/dispatchRefresh.ts`: `character-assets`, `character-blueprints`, `character-orders`, `character-wallet-transactions`, `character-industry-jobs`, `character-mercenary-dens`, `character-status`) are also dispatched on demand via the Vercel queue at `/api/queue/jobs` (the "Refresh ESI" flow), one message per character. The corp-scoped jobs (`PER_CORPORATION_JOBS`: `corp-wallet-transactions`, `corp-assets`, `corp-industry-jobs`) are dispatched **one message per corporation**, not per character — two of a user's characters in the same corp would otherwise race a concurrent reconcile of the same corp rows (duplicate-key aborts that leave items closed but never reopened); the message carries every character known to carry the job's scope for that corp so `forEachCorporation` can fall back through them if one lacks the required in-game role. `character-directory` and `universe-names` (`ACCOUNT_JOBS`) are dispatched once account-wide. On demand means: adding a character dispatches the full set for it (`dispatchRefresh`), and `/character/refresh` shows a per-character × per-job freshness matrix (fed by `latest_heartbeats()`) with a refresh button per stale cell that dispatches just that one job (`dispatchSingleJob`); nothing is auto-dispatched by merely visiting the page. The header shows the signed-in user's most recent extract heartbeat as a colored "Refreshed N minutes ago" indicator linking there. The remaining daily corp jobs (`corp-structures`, `corp-blueprints`, `corp-wallet-journal`) are never dispatched on demand — they do whole-corp work that isn't character-scoped, so a per-character fan-out would just redo the same pull once per character. `industry-systems` is similarly whole-universe work, but Chancellor accounts (see `src/app/account/chancellor`) get an extra row on `/character/refresh` to kick it on demand — `refreshCell` (`src/app/character/refresh/actions.ts`) gates that one job behind `isChancellor()` server-side, independent of `dispatchRefresh`'s own account-wide job list, so adding a character never fans it out.

Every `/api/cron/<job>/route.ts` checks the `Authorization: Bearer $CRON_SECRET` header Vercel signs cron requests with (see `src/utils/cron.ts`'s `requireCronSecret`), then does one of four things depending on the job's shape (also in `src/utils/cron.ts`):
- **Per-character jobs**: `fanOutPerCharacterCronJob` enumerates every character carrying the job's ESI scope (`selectCharacterIdsWithScopes` in `src/supabase.js`) and fans out one Vercel queue message per character — mirroring the on-demand "Refresh ESI" flow (`dispatchRefresh.ts`) — so each invocation stays small regardless of how many characters are registered. The queued consumer records its own per-character heartbeat (see `forEachCharacter`/`forEachCorporation` in `src/jobs/lib.js`). `character-status` used the `fanOutPerCharacterAnyScopeCronJob` variant (any of several scopes rather than one required scope) before it migrated — its workflow now unions the five scopes via the same `enumerateCharacters` step. **Phase 3 of the cron → Workflows migration is under way** (`docs/cron-to-workflows/03-per-character.md`): the scheduled path is moving from this queue fan-out to a per-character fan-out Vercel Workflow — the cron route `start()`s a like-named workflow under `src/workflows/` that enumerates the scoped characters itself (the shared `enumerateCharacters` step in `src/workflows/lib.ts`) and runs one `'use step'` per character across a few statically-assigned lanes (round-robin, so replay is deterministic), each failing character caught-and-continued with a summary rethrown so the run surfaces failures in Observability instead of the queue's silent re-loop. Per-character token refresh + heartbeats stay inside the untouched job module (`forEachCharacter`). Migrated so far: `character-wallet-transactions` (`characterWalletTransactionsWorkflow`), `character-orders` (`characterOrdersWorkflow`), `character-industry-jobs` (`characterIndustryJobsWorkflow`), `character-status` (`characterStatusWorkflow`, which unions the five any-scope endpoints), `character-mercenary-dens` (`characterMercenaryDensWorkflow`), and `character-blueprints` (`characterBlueprintsWorkflow`, the first paginated reconciler), all `source: 'vercel-workflow'`. The last one (`character-assets`) still uses `fanOutPerCharacterCronJob`. Only the scheduled trigger moves; the on-demand "Refresh ESI" queue path is untouched until phase 5. `character-skills` (`characterSkillsWorkflow`) uses this same fan-out shape but has no `vercel.json` crons entry of its own — `character-status` covers skills on the schedule (calling `syncCharacterSkills` inline), so the `/api/cron/character-skills` route is a deliberately unscheduled manual/backfill trigger that `start()`s the workflow.
- **Per-corporation jobs** (`corp-assets`, `corp-industry-jobs`, `corp-wallet-transactions`): `fanOutPerCorporationCronJob` groups scoped characters by corporation (`groupCharacterIdsByCorporation` in `src/supabase.js`) and sends one queue message per corp, avoiding the same-corp concurrent-reconcile race described above.
- **Account-wide jobs** (`character-directory`, `universe-names`): on the scheduled path these have migrated to single-step Vercel Workflows (phase 2 of the cron → Workflows migration, `docs/cron-to-workflows/`) — the cron route `start()`s `characterDirectoryWorkflow` / `universeNamesWorkflow` (`src/workflows/`), whose step runs the batch and records the whole-job heartbeat pair via `runJobWithHeartbeat` (`source: 'vercel-workflow'`). The on-demand "Refresh ESI" flow still dispatches them through the queue (`ACCOUNT_JOBS` in `dispatchRefresh.ts`), where the consumer records the whole-job heartbeat (`source: 'vercel'`); the `source` column tells the two paths apart. `dispatchAccountCronJob` is now unused on the scheduled path (deleted in phase 5).
- **Whole-corp/whole-universe jobs** (`industry-systems`, `universe-structures`, `corp-structures`, `corp-wallet-journal`, `corp-blueprints`): these no longer run inline via `runDirectCronJob` — all five have migrated to single-step Vercel Workflows (phase 1 of the cron → Workflows migration, `docs/cron-to-workflows/`, now **complete**). Each cron route `start()`s a like-named workflow under `src/workflows/` (`industrySystemsWorkflow`, `universeStructuresWorkflow`, `corpStructuresWorkflow`, `corpWalletJournalWorkflow`, `corpBlueprintsWorkflow`) whose single `'use step'` wraps the job's `run*()` in the same start/end heartbeat pair via `runJobWithHeartbeat` (`src/workflows/lib.ts`), now `source: 'vercel-workflow'` — gaining a per-step duration budget (so the old 60s inline cap no longer applies) and Workflows' bounded retries, visible under Observability → Workflows. The corp jobs' `forEachCorporation` per-corp heartbeat rows are preserved alongside the whole-job pair. `runDirectCronJob` itself is now unused (deleted in phase 5). The per-character/per-corp/account-wide jobs still dispatch via the queue shapes below until phases 2–4 migrate them too.

Requires a `CRON_SECRET` env var set in Vercel (see `.env.example`).

## Database tables (quick reference)

| Table | Purpose | Notable columns |
|---|---|---|
| `registration` | Linked EVE characters | `character_id`, `user_id`, `name`, `corporation_id` |
| `token` | OAuth tokens | `character_id` (unique FK), `access_token`, `refresh_token`, `expires_at`, `scope[]` |
| `character_asset_over_time` | SCD Type 2 asset history | `item_id`, `character_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `is_current`, `valid_from`, `valid_until`, `name` |
| `character_asset` | View: `is_current` assets | same columns as above |
| `character_blueprint_over_time` | SCD Type 2 blueprint history | `item_id`, `character_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `material_efficiency`, `time_efficiency`, `runs`, `is_current`, `valid_from`, `valid_until` |
| `character_blueprint` | View: `is_current` blueprints | same columns as above |
| `character_wallet` | Wallet balance history | `character_id`, `balance`, `recorded_at` |
| `character_wallet_transaction` | Trade history | `transaction_id`, `character_id`, `type_id`, `unit_price`, `quantity`, `is_buy`, `date` |
| `character_order_over_time` | SCD Type 2 open-order history | `order_id`, `character_id`, `type_id`, `price`, `volume_remain`, `is_buy`, `is_current`, `valid_from`, `valid_until` |
| `character_order` | View: `is_current` (still-open) orders | same columns as above |
| `character_industry_job_over_time` | SCD Type 2 industry-job history | `job_id`, `character_id`, `blueprint_id`, `product_type_id`, `activity_id`, `status`, `end_date`, `is_current`, `valid_from`, `valid_until` |
| `character_industry_job` | View: `is_current` industry jobs | same columns as above |
| `character_location` | Live current solar system/station/structure | `character_id` (PK), `solar_system_id`, `station_id`, `structure_id`, `recorded_at` |
| `character_clone_over_time` | SCD Type 2 clone history (home + jump clones, with implants) | `character_id`, `jump_clone_id`, `is_home`, `location_id`, `location_type`, `name`, `implants` (jsonb type-id array), `is_current`, `valid_from`, `valid_until`, `system_id` (resolved solar system, null until resolvable) |
| `character_clone` | View: `is_current` clones | same columns as above |
| `character_clone_state` | Live per-character clone-jump timers (next jump ≈ `last_clone_jump_date` + 24h) | `character_id` (PK), `last_clone_jump_date`, `last_station_change_date`, `recorded_at` |
| `character_implant` | Live current implants plugged into the character's active clone | `character_id` (PK), `type_ids` (bigint array), `recorded_at` |
| `character_skill_over_time` | SCD Type 2 trained-skill-level history (drives the character-list industry job-slot bubbles) | `id`, `character_id`, `skill_id`, `active_skill_level`, `trained_skill_level`, `is_current`, `valid_from`, `valid_until` |
| `character_skill` | View: `is_current` trained-skill levels | same columns as above |
| `character_ship_over_time` | SCD Type 2 history of the ship the character is piloting (docked or not); used to tag it in a station's asset listing | `character_id`, `ship_item_id`, `ship_type_id`, `ship_name`, `is_current`, `valid_from`, `valid_until` |
| `character_ship` | View: `is_current` ship | same columns as above |
| `character_mercenary_den_over_time` | SCD Type 2 history of a character's deployed Mercenary Dens — stable identity/config only | `id`, `character_id` (owner registration), `den_id`, `planet_id`, `type_id`, `skyhook_id`/`_corporation_id`, `is_current`, `valid_from`, `valid_until` |
| `character_mercenary_den` | View: `is_current` dens, each left-joined to its most recent `character_mercenary_den_status` observation | den columns above + `state`, `development_level`/`_amount`, `anarchy_level`/`_amount`, `infomorphs`, `reinforcement_end`, `status_observed_at` |
| `character_mercenary_den_status` | Append-only observation history of each den's volatile state (one row per den per extract run) | `id`, `character_id`, `den_id`, `state`, `development_level`/`_amount`, `anarchy_level`/`_amount`, `infomorphs`, `reinforcement_end`, `observed_at` |
| `character_mercenary_den_share` | Many-to-many: which dens are shared to which corporations (drives the corp-sharing RLS policy on `character_mercenary_den_over_time`). RLS: corpmates read shares aimed at their corps, owners read their own rows; writes are service-role only | `character_id`, `den_id`, `corporation_id`, `created_at` |
| `character_affiliation` | Character→Corp mapping | `character_id`, `corporation_id` |
| `corp_structure` | Corp Upwell structures | `structure_id`, `corporation_id`, `type_id`, `system_id`, `name`, `state`, `fuel_expires`, `services` (jsonb) |
| `corp_structure_rig` | Rigs on structures | `structure_id`, `location_flag`, `type_id`, `corporation_id` |
| `corp_wallet_journal` | Corp transaction log | `corporation_id`, `division`, `entry_id`, `ref_type`, `amount`, `date` |
| `corp_wallet_transaction` | Corp market buys/sells (unioned into market page) | `transaction_id`, `corporation_id`, `division`, `type_id`, `unit_price`, `quantity`, `is_buy`, `date` |
| `corp_asset_over_time` | SCD Type 2 corp asset history | `item_id`, `corporation_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `is_current`, `valid_from`, `valid_until` |
| `corp_asset` | View: `is_current` corp assets | same columns as above |
| `corp_blueprint_over_time` | SCD Type 2 corp blueprint history | `item_id`, `corporation_id`, `type_id`, `location_id`, `location_flag`, `quantity`, `material_efficiency`, `time_efficiency`, `runs`, `is_current`, `valid_from`, `valid_until` |
| `corp_blueprint` | View: `is_current` corp blueprints | same columns as above |
| `corp_industry_job_over_time` | SCD Type 2 corp industry-job history | `job_id`, `corporation_id`, `installer_id`, `blueprint_id`, `product_type_id`, `activity_id`, `status`, `end_date`, `is_current`, `valid_from`, `valid_until` |
| `corp_industry_job` | View: `is_current` corp industry jobs | same columns as above |
| `industry_system_index` | Cost index history (append-only) | `system_id`, `activity`, `cost_index`, `recorded_at` |
| `universe_name` | Cached id→name | `id` (bigint PK), `name`, `category` |
| `character_directory` | World-readable public identity directory (sharing layer, docs/sharing-layer/design.md); **no user_id**, so it can't correlate a user's alts. Populated by `character-directory` | `character_id` (bigint PK), `name`, `corporation_id`, `alliance_id`, `registration_id` (unique FK → registration) |
| `universe_structure` | Player structure cache | `structure_id`, `name`, `system_id`, `type_id` |
| `watched_system` | Per-user systems to track indexes for (drives `industry-systems` + `/indexes`) | `user_id`, `system_id`, `position` (drag order) |
| `shared_asset_token` | Public share links for own assets (`/ship/[itemId]?token=…`; hangar shares have no UI yet). Resolved server-side via the service client, which then scopes every query to the sharer's characters/corps — no anon RLS policy | `token` (PK, 16 random bytes hex), `user_id`, `item_id`, unique `(user_id, item_id)` |
| `user_settings` | User preferences | `user_id`, `enabled_scopes[]`, `api_token` (unique), `flags[]` |
| `invite_code` | Invite-only registration; redeeming an `is_chancellor` code confers Chancellor (admin) status | `code` (unique), `created_by`, `redeemed_by`, `redeemed_at`, `is_chancellor` |
| `refresh_task` | On-demand job tracking | `batch_id`, `user_id`, `job`, `character_id`, `status` (pending/running/done/error) |
| `heartbeat` | Cron job monitoring | `job`, `run_id`, `started_at`, `ended_at`, `duration` (generated), `character_id`, `corporation_id`, `user_id`, `owner_key` (generated) |
| `esi_etag` | Last ESI ETag per conditional-request cache key (service-role only; RLS on, no policy) | `cache_key` (PK, `<job>:<registration uuid>`), `etag`, `updated_at` |
| `sde_*` (mirror) | Nightly mirror of CCP's SDE, one table per JSONL file (`sde_types`, `sde_map_solar_systems`, …), minted by `ensure_sde_mirror_table()`; RLS on with a bare SELECT policy — readable by anyone, written only by the service-role ingest | `_key` (PK), `data` (jsonb, the raw JSONL line), `sde_build` |
| `sde_mirror_state` | One row per SDE build the ingest has seen; drives the skip decision (`planMirror`) — skip only when completed by the currently-deployed commit and < 7 days old (`--force` overrides on the CLI) | `build_number` (PK), `started_at`, `completed_at`, `commit_sha` |
| `sde_npc_station_name` | ESI-resolved NPC station display names (not in the SDE); never swept by build | `station_id` (PK), `name`, `updated_at` |
| `esf_data` | Base64-encoded eveship.fit protobuf files (the 6 `.pb2` `@eveshipfit/react` reads), re-encoded from the `sde_*` mirror by the `sde-mirror` workflow's `encodeEsf` step (`src/jobs/esfData.js`) after each SDE build — refreshes without a redeploy. Public-read RLS, service-role write | `name` (PK, e.g. `types.pb2`), `data` (base64), `sde_build`, `updated_at` |

Key Postgres functions (callable via RPC or SQL):
- `character_asset_location_summary()` — aggregate character assets per location
- `character_asset_location_contents(parent_id)` — count nested character items in a location
- `character_asset_search(type_ids[])` — every current character item matching one of the given type ids, with its root location and nested-item count (used by `/asset/search`)
- `corp_asset_location_summary()` — aggregate corp assets per location (mirrors the character version; RLS scopes to corps the caller has a registered character in)
- `corp_asset_location_contents(parent_id)` — count nested corp items in a location
- `corp_asset_search(type_ids[])` — mirrors `character_asset_search()` over corp assets (used by `/asset/search`)
- `asset_ancestors(start_id)` — one item's ancestor chain (enclosing containers up to the root station/structure/system), climbing the live `character_asset ∪ corp_asset` views, depth-capped at 16; feeds the `assetPath.tsx` breadcrumb on `/asset/[locationId]` and `/ship/[itemId]`
- `latest_heartbeats()` — most recent completed heartbeat per job per owner (character/corp/whole-job), RLS-scoped to the caller; feeds the `/character/refresh` freshness matrix
- `character_asset_snapshot_at(character_ids[], as_of)` — time-travel asset snapshot as JSON (used by `/api/character/assets`)
- `character_industry_jobs(character_ids[], include_delivered, as_of)` — time-travel industry-job snapshot as JSON (used by `/api/character/jobs`; `as_of` defaults to now, reconstructed from the SCD-2 history like `character_asset_snapshot_at`)
- `character_orders(character_ids[], as_of)` — time-travel open-order snapshot as JSON (used by `/api/character/orders`; `as_of` defaults to now)
- `character_blueprints(character_ids[])` — current blueprint snapshot as JSON, export for Sheets IMPORTDATA (used by `/api/character/blueprints`)
- `corp_assets(character_ids[])` — corp asset snapshot for the caller's corp(s), export for Sheets IMPORTDATA (used by `/api/corp/assets`)
- `corp_industry_jobs(character_ids[], include_delivered, as_of)` — time-travel corp industry-job snapshot for the caller's corp(s) as JSON (used by `/api/corp/jobs`; `as_of` defaults to now)
- `corp_blueprints(character_ids[])` — corp blueprint snapshot for the caller's corp(s), export for Sheets IMPORTDATA (used by `/api/corp/blueprints`)

## Design patterns

- **One extract job per ESI endpoint:** each job in `src/jobs/` pulls exactly one endpoint into its like-named table, sharing the token loops in `src/jobs/lib.js`. Job names double as npm script, queue message `job`, heartbeat label, and workflow file name.
- **Prefer ramda over `for`/`while` loops:** synchronous iteration uses ramda (`map`/`filter`/`reduce`/`pipe`/`chain`/`reject`/`forEach`, …) instead of imperative loops — `src/jobs/*.js` is the canonical example. Sequential *async* iteration (`for (const x of xs) { await ... }`) uses `forEachSequential(items, fn)` from `src/jobs/lib.js`, which chains promises through ramda's `reduce` so each item awaits before the next starts and a rejection propagates like a thrown error would out of a loop; an unbounded pagination loop (`for (let page = 1; ; page++)` / `for (let from = 0; ; from += PAGE_SIZE)`) becomes a small **tail-recursive** async function that fetches one page and recurses on the next range only while the page came back full — carrying `(from, acc)` as arguments, never a mutable loop counter. Canonical shape (prefer this over the `for`-loop generator still in `src/buildEsfData.js`'s `readMirror`, which predates the preference and should be migrated when next touched):

  ```js
  const readMirror = async (stem, from = 0, acc = []) => {
    const { data, error } = await sde().from(`sde_${stem}`).select('data').order('_key').range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`reading sde_${stem} failed: ${error.message}`)
    forEach((row) => acc.push(row.data), data) // ramda forEach, push-mutated accumulator
    return data.length < PAGE_SIZE ? acc : readMirror(stem, from + PAGE_SIZE, acc)
  }
  ```

  One accepted exception, visible above: when a `reduce`/`forEach` builds up a large array (an extract job can reconcile tens of thousands of rows), the accumulator is a plain object/array mutated via `.push()` rather than rebuilt with `[...acc, x]` on every item — spreading a new array per iteration turns an O(n) pass into O(n²). The loop itself still isn't a `for`/`while`; only the accumulator's internals are pragmatically mutable.
- **SCD Type 2 assets:** `character_asset_over_time` tracks the full history of each item. `is_current=true` rows form the current snapshot. `valid_until` is bumped each run for unchanged items; a new row is inserted when anything changes, and the old row's `is_current` is set to `false`. `corp_asset_over_time` (+ `corp_asset` view) mirrors this exact pattern for corp assets, reconciled in `src/jobs/corpAssets.js`. `character_blueprint_over_time` / `corp_blueprint_over_time` (+ their `_blueprint` views) apply the identical SCD-2 pattern to blueprints (location, quantity, ME/TE, runs), reconciled in `src/jobs/characterBlueprints.js` / `src/jobs/corpBlueprints.js`. `character_ship_over_time` (+ `character_ship` view) applies the same pattern with a single open row per character instead of one per item, reconciled in `src/jobs/characterShip.js`. `character_skill_over_time` (+ `character_skill` view) applies it keyed on `(character_id, skill_id)`, reconciled in `src/jobs/characterSkills.js`: a completed training opens a new version, and because a skill is never unlearned, a row is only ever superseded, never closed for vanishing. `character_order_over_time` (+ `character_order` view) and `character_industry_job_over_time` / `corp_industry_job_over_time` (+ their `_order`/`_job` views) apply SCD-2 keyed on `order_id` / `job_id`, reconciled in `src/jobs/characterOrders.js` / `characterIndustryJobs.js` / `corpIndustryJobs.js`: an order's fills and re-prices, or a job's status transitions, open new versions. The two families differ in how a row that vanishes from the ESI snapshot is handled — an order that vanished has **filled/expired/cancelled**, so it's closed (the view holds only still-open orders, matching the old sweep-delete); an industry job that vanished has just **aged past ESI's `include_completed` window**, so its terminal (delivered) row is left `is_current` (the view keeps every job ever reported, matching the old table that never swept completed jobs).
- **Asset location-walk functions come in two shapes:** the `*_location_summary()`/`*_location_contents()` functions seed their recursive climb/descend from *every* asset (they're computing an aggregate over the whole hangar). `character_asset_search()`/`corp_asset_search()` instead seed from just the rows matching a filter (a set of type ids), so a search stays cheap regardless of hangar size — reuse this seeded-recursion shape for any future "look up a few items, walk their location tree" function rather than the walk-everything shape.
- **Supabase RLS:** All tables use RLS scoped to `auth.uid()`. Cron scripts use the service-role key (`sudoSupabase` / `src/utils/supabase/service.ts`) which bypasses RLS.
- **Chancellor (admin) accounts:** an account that redeemed an `invite_code` with `is_chancellor=true`. `isChancellor(userId)` (`src/app/account/chancellor/chancellor.ts`) checks via the service role (a user's RLS view of `invite_code` only covers codes they created, not the one they redeemed). Gates `/account/chancellor` and the on-demand `industry-systems` refresh row.
- **Google Sheets IMPORTDATA:** `/api/character/assets`, `/api/character/blueprints`, `/api/character/orders`, `/api/character/jobs`, `/api/corp/assets`, `/api/corp/blueprints`, `/api/corp/jobs` authenticate via `user_settings.api_token`, call a Postgres function, and return CSV. The pre-rename paths permanently redirect to the new ones.
- **Vercel queue:** The queue consumer at `/api/queue/jobs` dispatches to the same `run*()` functions the CLI jobs use. The UI enqueues work via `@vercel/queue`.
- **Vercel Workflows pilot:** `character-implants` is the first extract job to execute as a Vercel Workflow (`workflow` package; `withWorkflow` wraps `next.config.mjs`, generating gitignored routes under `src/app/.well-known/workflow/`). The queue consumer special-cases it: instead of running the job inline, it `start()`s `characterImplantsWorkflow` (`src/workflows/characterImplants.ts`), whose single `'use step'` function calls `runCharacterImplants` unchanged — validating the queue → workflow → step chain (each step is its own function invocation with its own duration budget and bounded retries; runs/steps are visible under Vercel's Observability → Workflows) before any other job migrates. A manual, deliberately unscheduled trigger route at `/api/cron/character-implants` (CRON_SECRET-protected, no `vercel.json` crons entry — `character-status` already covers implants on the schedule) fans out the queue messages to exercise the chain in production. The job module itself is untouched and still CLI-runnable. (`character-skills` was briefly modeled on this pilot but now uses the newer phase-3 per-character fan-out workflow shape below — see its entry there.)
- **SDE mirror workflow:** `sde-mirror` is the second Vercel Workflow (`src/workflows/sdeMirror.ts`) and the first with real multi-step orchestration: its cron route (`/api/cron/sde-mirror`, 12:21 UTC — a fifth cron dispatch shape that just `start()`s the workflow) kicks a run that discovers CCP's current SDE build (the `latest` zip URL 302s to an immutable build-pinned URL carrying `x-sde-build-number`) and decides whether to re-ingest via `planMirror` (`src/jobs/sdeMirror.js`, shared by the workflow's `planRun` and the CLI): it **skips** — a ~5s no-op that just closes the heartbeat (`finalizeSkipped`) — only when the build is already completed, was produced by the currently-deployed git commit (`currentCommitSha()` from `VERCEL_GIT_COMMIT_SHA`/`COMMIT_SHA`, stored in `sde_mirror_state.commit_sha` by `finalizeBuild`), **and** is less than 7 days old; a new SDE build, a new code deployment (so a transform change re-runs), or 7-day staleness each force a **full re-ingest**, writing every JSONL entry into its `sde_<stem>` table in cursor-resumable slices — each step Range-reads only its entry's compressed bytes from the zip (no full download, no unzip binary; `node:zlib` inflates it) and upserts 500-row chunks until its ~35s budget runs out, returning the line cursor the orchestrator loops back in. Files ingest concurrently across a bounded pool of lanes (`INGEST_LANES`, statically assigned largest-first so replay is deterministic and the longest slice chains start first; safe because each file owns its own table and every step reads the same immutable zip), each file's slice chain staying sequential within its lane. Tables are minted at ingest by the service-role-only `ensure_sde_mirror_table()` RPC (so a new CCP file needs no migration), rows are stamped with `sde_build` and stale ones swept per file. The tail steps start as soon as the specific files they read have landed rather than after the whole ingest: station names resolve via ESI into `sde_npc_station_name` once `sde_npc_stations` drains, the `esf_data` re-encode starts once its 7 input tables drain, and finalize — last, after everything — refreshes `sde_blueprint_product` (`sde_refresh_views()`), marks the build completed, and closes the heartbeat the first step opened. All logic lives in `src/jobs/sdeMirror.js` (CLI-runnable with an unbounded budget). The app reads these mirror tables at runtime through the async `src/sde*.ts` loaders, and the `esf-data` cron/workflow job reads them to encode the ship-fitting protobufs into `esf_data` — the loader cutover is done, and both the `sde:build`/`src/buildSde.js` and `esf:build` build-time steps were removed, so the build touches no SDE at all.
- **MCP server:** `/api/mcp` (Streamable HTTP, via `mcp-handler`; route at `src/app/api/mcp/route.ts`) exposes read-only tools over the extracted data — `search_assets`, `list_clones`, `list_blueprints`, `list_industry_jobs`, `list_market_orders`, `search_transactions`, plus two SDE-backed industry tools `blueprint_for_product` (how to build an item + its material bill) and `blueprints_using_material` (what consumes an item) (`src/app/api/mcp/tools.ts`, shared plumbing in `lib.ts`). Tools accept fuzzy names (items/systems/owners resolved via the SDE search helpers) and return resolved names plus a `data_refreshed` freshness stamp from `latest_heartbeats()`. The two blueprint tools read only the generated SDE data (`src/sdeBlueprints.ts`) — not the extract DB — and adjust the material bill through the `eve-industry` `cost()` modifiers exposed as tool params (`runs`, `material_efficiency`, `structure`, `rig`, `security`); passing a monitored `structure_id` instead derives the structure role bonus, ME rig (by tier, category-agnostic — the rig name is reported for transparency), and system-security multiplier from `corp_structure`/`corp_structure_rig` (RLS-scoped) and overrides those three params. Auth is OAuth 2.1 with Supabase Auth as the authorization server: clients discover it via `/.well-known/oauth-protected-resource` (RFC 9728), the consent page lives at `/oauth/consent` (`supabase.auth.oauth.getAuthorizationDetails`/`approveAuthorization`/`denyAuthorization`), and `withMcpAuth` verifies bearer tokens with `auth.getClaims` (`src/app/api/mcp/auth.ts`). Every query runs on a client carrying the caller's token (`src/utils/supabase/bearer.ts`), so RLS scopes results exactly like the cookie session — tools never widen access and never call ESI. Requires the OAuth 2.1 server enabled in the Supabase dashboard (Authentication → OAuth Server) with the Authorization Path set to `/oauth/consent`, plus dynamic client registration for self-registering MCP clients like Claude.
- **Token lifecycle:** ESI OAuth tokens are stored in `token`. Before any ESI call, `refreshAccessToken()` checks expiry and refreshes via EVE SSO if needed.
- **ESI conditional requests (ETags):** the single-request snapshot jobs (`character-orders`, `character-wallet-transactions`, `character-industry-jobs`) send the last-seen ETag as `If-None-Match` (via `esiConditionalJson` in `src/esi.js`; the `orders`/`transactions`/`industryJobs` wrappers take an `ifNoneMatch` arg and return `{ status, json, etag }`). On a `304` the job skips its DB reconcile entirely and returns; on a `200` it reconciles and stores the new ETag *after* the write commits (`putEsiEtag`), so a mid-run failure never skips a fetch whose data wasn't persisted. ETags are kept in the service-role-only `esi_etag` table keyed `<job>:<registration uuid>`. Only applied to endpoints that return the whole collection in one request — one ETag covers the full response, so a `304` unambiguously means "nothing changed." Paginated endpoints (assets/blueprints) would need per-page ETag bookkeeping and are deliberately left unconditional for now. Each request emits an `esi.conditional_request` metric line (`recordEsiConditional` in `src/observability.js`) with `job`/`outcome` (`not_modified`/`modified`)/`duration_ms`, so the 304 hit rate and latency are queryable in Vercel Observability without an OpenTelemetry exporter (see below).
- **Vercel Observability metrics:** `src/observability.js` emits structured single-line JSON metrics to stdout (`{ metric, … }`), which Vercel ingests from function logs and can filter/aggregate in the Observability dashboard — deliberately zero-dependency (no `@vercel/otel`, which would need a package.json + lockfile change) and the single seam to later swap in real OTel counters. First use is the ESI conditional-request hit rate.
- **Name resolution:** `universe_name` table caches ESI `universeNames` lookups (kept fresh by the `universe-names` job). `resolveBatch()` handles bisect-on-error for large batches. Type names (items/ships) come from the locally generated SDE data (`src/sdeTypes.ts`), not the DB.
