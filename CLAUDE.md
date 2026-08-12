# Project overview

EVE Online hangar/wallet/industry tracker, deployed on Vercel.

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript 6, ESM. Supabase (Postgres). `ramda` for utilities; `ts-pattern` for branching on string-literal unions where `.exhaustive()` catches new members at build time — it does not replace early-return guard chains or range comparisons (`freshnessLevel`, `securityMultiplier`, mercenary-den `colorOf` stay plain ifs).
- **Node:** 24.18.0 (`.node-version`). **Package manager:** pnpm (pinned via `packageManager` in `package.json`).
- **Path alias:** `@/*` → `./src/*`.

## Commands

- `pnpm run dev` / `build` / `start`.
- `pnpm run lint` — `eslint .` (`no-explicit-any` off, unused vars allowed with `^_` prefix).
- `pnpm run pretty` — `prettier --write src/` (`@philihp/prettier-config`).
- `pnpm test` — `node --test "test/**/*.test.ts"`. Node's built-in runner over the few pure-logic modules (no framework; Node strips TS types itself, hence `.ts` import extensions). Most code is I/O against Supabase/ESI, verified by `build` + `lint` rather than tests.
- `pnpm run test:sql` — `psql $DATABASE_URL -f test/sql/blueprint_search.sql`; point at a **throwaway** DB (creates stand-in tables named like real views; rolls back).
- `pnpm run test:branch` — `test/signupBranch.test.ts` against a real Supabase **preview branch** (Pro database branching): registration end to end, from invite code through `auth.users` to the new account's RLS scope. Needs `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` (creates an ephemeral branch and deletes it) or `SUPABASE_TEST_BRANCH_URL`/`_ANON_KEY`/`_SERVICE_KEY` (reuses one). Skips with a printed reason when neither is set, so it's inert under plain `pnpm test`. Helper: `test/lib/supabaseBranch.ts`.
- No `typecheck` script (rely on `next build`).
- Pre-commit: husky runs `lint-staged` (prettier + `eslint --fix` on staged files) then `pnpm run lint`.
- **The build downloads nothing from CCP and never touches the SDE** — no `predev`/`prebuild` steps. SDE data reaches runtime only through the nightly-mirrored tables (see Architecture).
- `pnpm run esf-data` / `sheet-csv` / `sde-mirror` — manual runs of the SDE mirror and its tail encoders (`src/jobs/esfData.js`, `src/jobs/sheetCsv.js` — a JS port of `docs/sheet-csv/reference/full_sheet_gen.py` — and `src/jobs/sdeMirror.js`, `--force` re-ingests); the first two also have unscheduled `CRON_SECRET`-protected `/api/cron/*` routes (`?force=1`). See the SDE mirror workflow pattern.
- **Vendored `@eveshipfit/*`:** `react` and `dogma-engine` tarballs committed under `vendor/eveshipfit/` with `file:` specifiers (no GitHub Packages token at install); `@eveshipfit/data` is replaced by the stub `vendor/eveshipfit/data-stub/`. To bump: `npm pack @eveshipfit/<pkg>@<version>`, drop the `.tgz` in, update the `file:` path, `pnpm install`.
- Extract jobs: `pnpm run <job>` for each job name (see Extract jobs), plus `heartbeat`. `connect`, `ping`, `refresh` are DB/token utilities.
- DB migrations (Supabase CLI): `pnpm run db:new <name>` scaffolds under `supabase/migrations/`; `pnpm run db:push` applies to the linked project. Push to `main` touching `supabase/migrations/**` runs the `Migrate` workflow automatically.

## Layout

- `src/app/` — App Router pages: `account/`, `asset/`, `blueprint/`, `character/`, `corpses/`, `fitting/` (library as hull-class × race matrix `fittingMatrix.tsx` + one fit in the eveship.fit wheel with corp/alliance/public sharing; bucketing seam `shipMatrix.ts`), `indexes/`, `industry/`, `market/`, `mercenary-dens/`, `ship/` (eveship.fit wheel + stats — space reserved by `fitPlaceholder.tsx` — plus `LocationAssets` module/cargo table in `flagSortKey` order; `/asset/[id]` redirects ships here), `structure/`, `settings/`, `oauth/`, `xrpc/`, `layout/` (Header/Footer), `error/`, `private/`. Shared helpers at top level (see routes section).
- `src/` (Node cron/scripts): `esi.js`, `supabase.js`, `resolveNames.js`, `tokenRefresh.js`/`refresh.js`, `proxy.ts`, `utils/`. Extract jobs under `src/jobs/` plus shared plumbing in `src/jobs/lib.js` (see Extract jobs).
- `schema.sql` — single source of truth for the schema. It's a full reset (DROPs and recreates — wipes data). To change schema: edit it **and** add a non-destructive incremental migration under `supabase/migrations/`.
- `.github/workflows/` — `heartbeat.yml` (daily canary, stays on Actions); `test.yml` (PR check: lint + `pnpm test` on every PR, and `test:branch` on same-repo PRs touching migrations/schema/account/auth, serialized, with `.github/scripts/sweep-test-branches.mjs` reaping leaked branches); `migrate.yml` (applies migrations on push to `main`); `bump-eveshipfit.yml` (Mondays; checks GitHub Packages for newer vendored packages, re-packs, opens/updates a PR). ESI extract jobs all moved to Vercel Cron because Actions schedules fired unreliably.

## Database & ESI

- DB lives in the default `public` schema (no `.schema()` qualifier). Extract tables are named after the ESI endpoint feeding them, prefixed by owner scope: `character_*`, `corp_*`, `universe_*`. All tables RLS-scoped to `auth.uid()`; cron uses the service-role key.
- **Id naming — `character_id` means the EVE numeric (bigint) id; the registration uuid is `registration_id`.** **Most existing `character_*` extract tables get this wrong** — their owner column is declared `character_id uuid references registration(id)`, so it holds the registration uuid despite the name (legacy wart; why the fitting route has a uuid first segment). `character_directory` does it right. Name new columns/params correctly even next to a legacy one, and read existing `character_id` for what it actually holds. Don't fold the rename into unrelated work — `docs/registration-id-rename.md` stages that cleanup.
- ESI base `https://esi.evetech.net/latest` via `src/esi.js`. Tokens live in `token`; `refreshAccessToken()` refreshes via EVE SSO before any ESI call.
- **Data flow:** ESI → DB (extract jobs) → server components read DB. Server components must NOT call ESI directly.
- Env vars (`.env.example`): `EVE_*` (SSO), `SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_*`, `GICE_*` (Goonfleet SSO; start route 503s when unset), Turnstile keys (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` guards the anonymous sign-in; unset skips the challenge), `CRON_SECRET`.

# Workflow

- **Always** `git fetch origin && git rebase origin/main` immediately before pushing and opening a PR. Every time, no exceptions.
- **Never rename an existing file under `supabase/migrations/`.** A migration's filename is its identity to the Supabase CLI and every environment that already applied it; renaming desyncs whichever environment isn't on the renaming commit (happened for real in #614/#615/#616 — each rename re-broke `supabase db push`). If ordering or content is wrong, add a **new** migration with a fresh timestamp.
- **Two migrations may share a timestamp** — `schema_migrations` is keyed on `(version, name)` since migration `20260727000000` (after two production collisions repaired by hand). The ordering guard in `.github/scripts/check-migrations.mjs` forbids back-dating; the composite key covers what it can't catch (two open PRs with the same new timestamp merging). Still prefer distinct timestamps.

# Architecture

- The legacy `evesde` schema is dropped — do not recreate or reference it; if a lookup has no non-SDE source, show the raw ID.
- Type/group/category/system/station/blueprint/planet lookups resolve at runtime through the `src/sde*.ts` loaders, over the nightly-mirrored `sde_*` tables/views (`sde_published_type`, `sde_kspace_system`, `sde_station`, `sde_planet`, `sde_blueprint_product`, taxonomy views `sde_group`/`sde_category`/`sde_region`, search RPCs `sde_search_type`/`sde_search_system`), populated by the `sde-mirror` workflow from CCP's official SDE (`developers.eveonline.com/static-data`, JSONL — **never Fuzzwork's mirror, off-limits**). Loaders query via the public-read anon client `src/utils/supabase/sde.ts`, caching by-id lookups per process for 6h (misses never cached; `src/sdeCache.ts`). If a needed field isn't in a view, extend the view in `src/jobs/sdeMirror.js` + a migration.

# Codebase map

## Key source file exports

### `src/buildEsfData.js`

- `encodeEsfData()` — reads the 6 protobuf inputs from `sde_*` tables via anon key, applies vendored dogma patches (`src/esfPatches.json`), encodes per `src/esf.proto`, returns `{ [fileName]: Buffer }`. Also `ESF_FILE_NAMES`. Called only by `src/jobs/esfData.js`; `/esf/[file]` serves the rows.

### SDE loaders (async, DB-backed, cached per process via `src/sdeCache.ts` unless noted)

- `src/sdeTypes.ts` — `getSdeTypes(typeIDs[])` (→ `{ typeID, name, groupID, categoryID, groupName, raceID, metaGroupID }`), `getSdeType`, `getSdeTypeNames`, `searchSdeTypesAll(query)` (ranked by match coverage, capped 1000 = RPC max; results carry `categoryID`), `searchSdeTypes(query, limit?)` (autocomplete)
- `src/sdeSystems.ts` — `getSdeSystems(systemIDs[])` (→ `{ systemID, name, security }`), `getSdeSystem`, `getSdeSystemNames`, `searchSdeSystems(query, limit?)` (backs /indexes autocomplete), `formatSecurity` (sync, pure, one-decimal)
- `src/sdeStations.ts` — `getSdeStations(stationIDs[])` (→ `{ stationID, name, systemID }`), `getSdeStation`, `getSdeStationNames`, `getSdeStationSystems` (station→system id; SDE has it, ESI `universe/names` never did)
- `src/sdePlanets.ts` — `getSdePlanets(planetIDs[])` (→ planet + system/region/security; `name` = `"<system> <roman>"`, e.g. `RXA-W1 III`, same key as the mercenary-den intel), `getSdePlanet`, `getSystemPlanets(systemIDs[])` (celestial order, uncached), `getRegionPlanets(regionID, planetTypeIDs?)` (tail-recursively paged past PostgREST's 1000-row cap), `toRoman(n)`, constants `TEMPERATE_PLANET_TYPE_ID` (11), `PLANET_GROUP_ID` (7 — the SDE group whose members are the planet types; never hardcode a list). Backs `/mercenary-dens` and MCP `list_planets`
- `src/sdeRegions.ts` — `searchSdeRegions(query, limit?)`: ILIKE over the ~70-row `sde_region` view + JS sort (no RPC). Uncached
- `src/sdeBlueprints.ts` (over `sde_blueprint_product` materialized view; not cached) — `getBlueprintForProduct(productTypeID)` (manufacturing preferred over reaction, or `null`), `getBlueprintsForMaterial(materialTypeID)` (GIN `@>` probe on `materials` jsonb). `Blueprint` = `{ blueprintTypeID, activityID, productTypeID, productQuantity, materials: [{ typeID, quantity }] }`; `MANUFACTURING`/`REACTION` constants. Backs MCP `blueprint_for_product`/`blueprints_using_material`

### `src/esi.js` — ESI wrapper

Functions take `(accessToken, id, ...)`; return raw ESI JSON (paged wrappers return `[json, xPagesHeader]`). Character: `assets`/`blueprints` (paged), `transactions`, `wallet`, `orders`, `industryJobs`, `character`, `characterLocation`, `characterClones`, `characterImplants`, `characterShip`, `fittings(token, id, ifNoneMatch)` (ETag-aware, returns `{ status, json, etag }`; ESI exposes **only personal** fittings — no corp/alliance endpoint, `docs/fittings.md`), `characterMercenaryDens`/`characterMercenaryDen` (compatibility-date ESI: kebab-case path, `X-Compatibility-Date` header — `esiCompatJson`), `contracts` (paged)/`contractItems` (tolerant: 403/404 → `{ status, json: null }` via `esiJsonTolerant`, since a contract we can list can still be unreadable). Corp: `corpStructures`/`corpAssets`/`corpBlueprints`/`corpIndustryJobs`/`corpContracts` (paged), `corpContractItems` (tolerant), `corpWalletJournal(…, division, page)`, `corpTransactions(…, division)`. No auth: `industrySystems`, `universeNames(ids[])`, `universeStation`, `characterAffiliations`. Also `assetNames(token, characterId, itemIds[])`, `universeStructure`.

### `src/jobs/lib.js` — shared extract-job plumbing

- `forEachCharacter(tag, { scope, registrationIds, heartbeat = true }, handler)` — iterate tokens carrying a scope, refresh each, call handler with `{ access_token, characterID, registration_id, userId, name, ctx, scopes }`; start/end heartbeat rows per character
- `forEachCharacterAnyScope(tag, { scopes, ... }, handler)` — tokens carrying **any** of `scopes` (for `character-status`); handler reads `scopes` to run only authorized endpoints
- `forEachCorporation(tag, { scope, registrationIds }, handler)` — one call per corporation; keeps `registration.corporation_id` fresh; per-corp heartbeats
- `fetchAllPages(fetchPage)`; `forEachSequential(items, fn)` (ramda-based sequential async iteration); `cli(import.meta.url, tag, run)` (self-run as CLI)

### `src/supabase.js`

- `supabase` (anon, respects RLS); `sudoSupabase` (service role, cron only)
- `recordHeartbeat(job, phase, opts)` — start/end pair upserts one row keyed on `job, run_id, run_attempt, owner_key` (generated column folding registration/corp ids into one non-null discriminator)
- `authenticate()` (anon sign-in for CLI utilities); `upsertCharacter`, `upsertToken`, `selectCharacters(columns, owner?)`, `selectRegistrationIdsWithScopes(scopes[])`, `groupRegistrationIdsByCorporation(scopes)` (→ `{ byCorp, unresolved }`), `selectToken(characterId, scope?[])`
- `getEsiEtag`/`putEsiEtag(cacheKey, etag)` — ESI ETag cache (`esi_etag`); best-effort (DB failure degrades to unconditional fetch)

### `src/tokenRefresh.js` / `src/resolveNames.js`

- `refreshAccessToken(tokenRow)` — refresh via EVE SSO, update DB, return new token
- `resolveBatch`/`resolveAllIds` (bulk `universeNames`, bisect-on-error), `resolveCorpJournalNames`, `resolveKnownCorpNames`, `resolveCorpIndustryJobInstallerNames`, `resolveCorpStructureSystemNames`, `resolveAssetStationNames`, `resolveAssetSystemNames`

### `src/app/blueprint/rigs.ts` / `src/app/industry/jobSlots.ts`

- `rigsForProduct(groupID, categoryID)` / `rigAppliesToProduct(rigTypeID, groupID, categoryID)` — which Upwell rigs' material modifiers cover a product, from vendored eveship.fit modifier tables (`filtersUsed` + `rigsForFilter`); rigs with no `filterID` aren't listed. Consumers: `/blueprint/[typeID]`, MCP `rigs_for_blueprint`, the `structure_id` bonus resolver in `src/app/api/mcp/tools.ts`
- `jobSlots.ts` — `ACTIVITY_FAMILY`, `SLOT_SKILLS`/`SLOT_SKILL_IDS`/`SKILL_FAMILY`/`SKILL_NAME` (six slot skills; 1 free slot + 1 per active level, ceiling 11), `baseSlotMax()`/`emptyCounts()`, `SLOT_FAMILIES`. Shared by `/character` slot bubbles and MCP `list_job_slots`.

### `src/utils/`

- `apiToken.ts` — `resolvePlayer(token)` for Sheets endpoints → `{ ok, supabase, registrationIds }` or error
- `csv.ts` — `toCsv(rows)` (RFC 4180); `atParam.ts` — `parseAtParam(raw)` for the `at=` time-travel param (pads partial ISO dates)
- `queue.ts` — region-pinned `@vercel/queue` client (default `sfo1`) + `send`/`handleCallback`
- `cron.ts` — `requireCronSecret`; `runDirectCronJob` kept only for the `esf-data`/`sheet-csv` bootstrap routes
- `escapeLike.ts` — escapes `%`/`_`/`\` before `.ilike()`; `sdeCategories.ts` — `BLUEPRINT_CATEGORY_ID` (9). Both in `utils/` because their callers sit in layers that must not import each other (`structureQuery.ts` re-exports `escapeLike`)
- `supabase/server.ts`/`service.ts`/`bearer.ts`/`sde.ts` — server-cookie / service-role / OAuth-bearer client factories; `sde.ts` is a lazy **anon** client for the public-read `sde_*` tables, usable in every context, never for writes. **There is no browser client** — session cookies are httpOnly (`supabase/cookieOptions.ts`, applied by `server.ts` and `src/proxy.ts`), so `createBrowserClient` would see no session. Every Supabase call is server-side

## App routes → files

Routes follow the App Router convention: `/<path>` → `src/app/<path>/page.tsx` (or `route.ts` for handlers). Pages: `/`, `/account/{login,register,settings,invite,reset,email,debug}`, `/account/settings/chancellor`, `/account/gice/complete`, `/asset`, `/asset/[locationId]`, `/asset/search`, `/ship/[itemId]`, `/character`, `/jobs`, `/market`, `/industry`, `/indexes`, `/mercenary-dens`, `/corpses/[characterID]`, `/structure`, `/structure/revenue`, `/structure/[structureId]`, `/settings/grants`, `/blueprint`, `/blueprint/[typeID]`, `/fitting`, `/fitting/[characterId]/[fittingId]`, `/oauth/consent`. Handlers: `/account/confirm`, `/account/gice` (+`/callback`), `/character/callback`, `/esf/[file]`, `/sheets/[file]`, `/api/mcp`, `/.well-known/oauth-protected-resource`, `/api/{character,corp}/*` (CSV), `/api/type/search`, `/xrpc/[method]`.

Notable pages:

- `/mercenary-dens` — unions extracted dens (own + alliance-shared via RLS) with hand-maintained intel in `src/app/mercenary-dens/data.ts`; server-side SVG topology (`topology.tsx`, red reinforced > green ours > yellow external) + table; `shareAlliance.tsx` picks the share alliance.
- `/corpses/[characterID]` — public share page (no login). Service-role client scoped to the owning account's registrations; lists corpse items, pilot name derived from `"<pilot>'s Frozen Corpse"`, "New!" badge within 48h.
- `/structure/revenue` — corp `industry_job_tax` revenue from `corp_wallet_journal` by UTC day; range-pages past PostgREST's 1000-row cap.
- `/account/settings/chancellor` — admin subpage for Chancellors. Grants/revokes Chancellor via invite codes; sets dark-launch flags (`user_settings.flags`; `KNOWN_FLAGS` in `src/flags.ts` plus whatever the target already carries). Old `/account/chancellor` redirects here.
- `/account/gice` + callback + complete — GICE (Goonfleet OIDC SSO); hand-rolled auth-code client (`docs/gice-auth.md`). Invite-only; SSO accounts get placeholder email `gice-<id>@sso.edencom.link`; sessions minted passwordlessly via `mintSession` (service-role `generateLink` magiclink consumed by `verifyOtp`).
- `/account/email` — add/change email for SSO-only accounts; needs Supabase "Secure email change" off (placeholder can't receive mail).
- `/xrpc/[method]` — edge stub answering ATProto XRPC with 404 JSON (domain used to run a PDS; rejects bot noise cheaply).

Old CSV endpoint paths (`/api/assets`, `/api/orders`, `/api/industry`) and `/characters/refresh` permanently redirect; `/asset/:itemId/fit` temporarily redirects to `/ship/:itemId` (`next.config.mjs`, which also sets `turbopack: {}` for dogma-engine WASM and injects `BUILD_TIME`/`COMMIT_SHA`).

Shared UI helpers: `src/app/isk.ts`, `DateTime.tsx`, `typeName.tsx`/`typeNames.ts`, `systemNames.ts`, `stationNames.ts`, `names.tsx` (serif wrappers with `#id`/`—` fallbacks), `assetPath.tsx` (breadcrumb fed by `asset_ancestors()`), `owners.ts`/`ownerFilter.tsx` (owner picker shared by assets/industry), `resolveLocations.ts` (root locations → names + systems; it and `owners.ts`/`systemNames.ts`/`stationNames.ts` take an optional Supabase client so MCP tools can pass a bearer client), `freshness.ts`/`Freshness.tsx` (green <15m, yellow <75m, red beyond).

## Extract jobs

One job per ESI endpoint, sharing the token loops in `src/jobs/lib.js`; entry point is the camelCased file under `src/jobs/` exporting `run<PascalCase>()`, self-runnable as a CLI. Job names double as npm script, heartbeat label, and workflow file name; every job is scheduled by a like-named Vercel Cron entry (`vercel.json` crons + `src/app/api/cron/<job>/route.ts`).

Each job pulls its like-named ESI endpoint into its like-named table (exact schedules in `vercel.json`). Every 6h at staggered minutes: the per-character jobs, `corp-wallet-journal`, `corp-industry-jobs`, `corp-wallet-transactions`, `corp-contracts`, `universe-names`, `industry-systems`. Daily: `corp-blueprints`, `corp-structures`, `corp-assets` (also writes `corp_structure_rig`), `universe-structures`, `character-directory` (writes `character_directory`, `corporation`, `alliance`, `character_affiliation`, `registration.corporation_id`), `sde-mirror` 12:21, `anon-sweep` 04:13 (deletes never-converted anonymous accounts; the one job whose "endpoint" is `auth.users`).

`character-status` (`src/jobs/characterStatus.js`) is the one exception to "one job per endpoint": it folds six cheap per-character pulls (wallet, location, implants, clones, ship, skills) into one extract, writes to each endpoint's original table, keeps separate scopes (`forEachCharacterAnyScope`; a character runs only endpoints its token carries), and fault-isolates each endpoint. The individual six modules still run standalone via CLI — each exports a `sync*` helper `characterStatus.js` calls — but only `character-status` is scheduled.

`src/heartbeat.js` (`heartbeat.yml`, daily) is a canary proving heartbeat recording works; stays on GitHub Actions.

On-demand dispatch ("Refresh ESI", `src/app/character/dispatchRefresh.ts`): `PER_CHARACTER_JOBS` (the nine per-character jobs) dispatch one workflow run per character — `dispatchRefresh`/`dispatchSingleJob` `start()` the same workflows the cron routes do, passing an `OnDemandTarget` (`src/workflows/lib.ts`): pre-enumerated `registrationIds` (skips the enumerate step) plus the `refresh_task` row id the step flips running → done/error via `withRefreshTask` (best-effort, so the matrix settles on a terminal state). `PER_CORPORATION_JOBS` (corp-wallet-transactions, corp-contracts, corp-assets, corp-industry-jobs) dispatch **one run per corporation** (two alts in one corp would race a concurrent reconcile — duplicate-key aborts leaving items closed but never reopened); the target carries every scoped character for that corp so `forEachCorporation` can fall back through them. `ACCOUNT_JOBS` (character-directory, universe-names) dispatch once account-wide. Adding a character dispatches the full set; `/jobs` (docs/jobs-page.md) shows one row per job (characters / corporations / shared universe) over `latest_heartbeats()` (carries `ok`/`error`, so a failed scheduled run reads failed), open heartbeats (scheduled run in flight) and the caller's `refresh_task` rows (per-cell refresh buttons + 24h activity); next-run countdowns from `vercel.json` crons via pure `schedule.ts`/`registry.ts`, row reductions in pure `rows.ts` (tested). `/character/refresh` is gone (permanent redirect); nothing auto-dispatches on visit. The daily corp jobs are never on-demand; `industry-systems` gets a Chancellor-only row (`refreshCell` gates it server-side).

Every `/api/cron/<job>/route.ts` checks `Authorization: Bearer $CRON_SECRET` (`requireCronSecret`), then `start()`s the job's like-named Vercel Workflow under `src/workflows/` — the cron → Workflows migration (`docs/cron-to-workflows/`) is **complete**; the on-demand path starts the same workflows, so every job has exactly one execution engine. Three shapes:

- **Per-character fan-out** (the nine per-character jobs): the workflow enumerates scoped characters itself (shared `enumerateCharacters` step, unioning scopes — how `character-status` fronts six endpoints) and runs one `'use step'` per character across statically-assigned lanes — round-robin via `transpose(splitEvery(LANES, ids))` for deterministic replay — draining each lane sequentially via a `reduce` promise-chain. Failing characters are caught-and-continued, thrown together as an `AggregateError` at the end. Token refresh + heartbeats stay inside the job modules (`source: 'vercel-workflow'`). `character-skills` uses this shape but has no crons entry (`character-status` covers skills); its cron route is a deliberately unscheduled manual/backfill trigger.
- **Per-corporation fan-out** (corp-assets, corp-industry-jobs, corp-wallet-transactions, corp-contracts): groups characters by corp (shared `enumerateCorporations` step, plus singleton groups for unresolved characters), one `'use step'` per corp. A corp's characters stay together in one step (never split — two concurrent reconciles once corrupted the SCD-2 data); only different corps run concurrently; failures caught-and-continued with a summary rethrown.
- **Single-step** (all remaining jobs): one `'use step'` wraps `run*()` in the heartbeat pair via `runJobWithHeartbeat`, gaining a per-step duration budget (no 60s inline cap) and bounded retries; visible in Observability → Workflows.

## Database tables (quick reference)

Full column detail lives in `schema.sql`. SCD-2 tables (`*_over_time`) each have a like-named view of `is_current` rows (e.g. `character_asset`).

- `registration` — linked EVE characters (`id` uuid PK, `character_id` bigint, `user_id`, `name`, `corporation_id`)
- `token` — OAuth tokens; `registration_id` (unique FK; renamed from `character_id`, step 1 of `docs/registration-id-rename.md`), tokens, `expires_at`, `scope[]`
- SCD-2 histories + views: `character_asset_over_time`, `character_blueprint_over_time` (+ME/TE/runs), `character_order_over_time`, `character_industry_job_over_time`, `character_clone_over_time` (home + jump clones, `implants` jsonb), `character_skill_over_time` (drives job-slot bubbles), `character_ship_over_time` (single open row per character), `character_fitting_over_time` (`registration_id` named correctly unlike its siblings; `owner_scope` always `character`; `items` jsonb `[{ type_id, flag, quantity }]`), `character_mercenary_den_over_time` (stable den identity/config; its view left-joins the latest status observation)
- Live/per-character: `character_wallet` (balance history), `character_wallet_transaction`, `character_location`, `character_clone_state` (jump timers), `character_implant` (`type_ids` array)
- `character_contract` / `character_contract_item`, `corp_contract` / `corp_contract_item` — contracts and their contents (`character-contracts`/`corp-contracts`). Contracts are mutable (status/acceptor/completion advance), so these upsert **in place** rather than SCD-2: the state machine is already dated by ESI's own columns. Keyed `(registration_id, contract_id)` / `(corporation_id, contract_id)` — never `contract_id` alone, since a contract is visible to *both* parties and issuer and acceptor may be on different accounts. `items_fetched_at` gates the item pull: contents never change, so each contract is itemised once (≤100 per owner per run, newest first) and never re-polled, including on a tolerated 403/404. Shared pure mapping in `src/jobs/contractFields.js` (tested)
- `character_mercenary_den_status` — append-only den observations (state, development/anarchy, infomorphs, `reinforcement_end`, `observed_at`)
- `character_fitting_share` — per-fit shares, one row per level (`corporation`/`alliance`/`public`), each a toggle; no secrets, no anonymous view. Widens RLS on `character_fitting_over_time` via `fitting_shared_with_caller()` (invoker rights): owner affiliation via world-readable `character_directory` (never RLS-hidden `registration`), caller membership via `my_corporation_ids()`/`my_alliance_ids()`; `public` = any signed-in user. An audience policy on the share table itself lets members read rows aimed at them. Points at the live fit; the fitting route addresses by EVE character id, translated by `src/app/fitting/resolveCharacter.ts`. `token` column is an unused placeholder
- `character_mercenary_den_share` — one row = "this owner shares dens **and** enemy-den intel with this alliance" (`registration_id` grantor, `alliance_id`). `mercenary_den_shared_with_caller()` matches against `my_alliance_ids()`, drives RLS on den history and `mercenary_den_enemy_intel`; invoker rights, no SECURITY DEFINER
- `character_affiliation` — character→corp mapping
- `corp_structure` (incl. `state`, `fuel_expires`, `services` jsonb), `corp_structure_rig`, `corp_wallet_journal` (by `division`, `ref_type`), `corp_wallet_transaction`
- `corp_asset_over_time` / `corp_blueprint_over_time` / `corp_industry_job_over_time` — SCD-2 corp mirrors keyed on `corporation_id` (industry jobs add `installer_id`)
- `industry_system_index` — append-only cost indices; `universe_name` — cached id→name; `universe_structure` — player structure cache
- `character_directory` — world-readable identity directory; **no user_id** so it can't correlate alts: `character_id` (bigint PK), `name`, `corporation_id`, `alliance_id`, `registration_id` (unique FK)
- `watched_system` — per-user systems for index tracking
- `shared_asset_token` — public share links for own assets (`/ship/[itemId]?token=…`); resolved server-side via service client scoped to the sharer's characters/corps — no anon RLS policy. `token` PK (16 random bytes hex), unique `(user_id, item_id)`
- `gice_account` — GICE ↔ Supabase link; written only by service role after verified OAuth callback (`gice_id` = OIDC `sub`)
- `user_settings` — `user_id`, `enabled_scopes[]`, `api_token` (unique), `flags[]`
- `invite_code` — referrals (open registration, `docs/open-registration.md`): `redeemed_by` is the account a code referred, affixed on arrival at `/account/register?invite=…` and unique per account; `is_chancellor` codes confer admin
- `refresh_task` — on-demand job tracking (`batch_id`, `job`, `registration_id`, `status`)
- `heartbeat` — job monitoring (`job`, `run_id`, start/end, generated `duration` and `owner_key`)
- `esi_etag` — ETag per conditional-request cache key (`<job>:<registration uuid>`); service-role only (RLS on, no policy)
- `sde_*` — SDE mirror, one table per JSONL file, minted by `ensure_sde_mirror_table()`; public SELECT, service-role write (`_key` PK, `data` jsonb, `sde_build`)
- `sde_mirror_state` — one row per SDE build (drives `planMirror` skip decision); `sde_npc_station_name` — ESI-resolved NPC station names (not in SDE), never swept
- `esf_data` — base64 eveship.fit protobufs re-encoded per SDE build (refreshes without redeploy); `sheet_csv` — spreadsheet static CSVs served at `/sheets/[file]` for Sheets `=IMPORTDATA()` (public, CDN-cached, ETag keyed on `sde_build`). Both public-read, service-role write, keyed on `name`

Key Postgres functions (RPC or SQL):

- `character_asset_location_summary()` / `character_asset_location_contents(parent_id)` — aggregate assets per location / count nested items; `corp_*` mirrors exist (RLS scopes to caller's corps)
- `character_asset_search(type_ids[])` / `corp_asset_search(type_ids[])` — current items matching type ids, with root location + nested count (`/asset/search`)
- `asset_ancestors(start_id)` — ancestor chain to root over both asset views, depth-capped 16; feeds `assetPath.tsx`
- `blueprint_search(...)` — the MCP `list_blueprints` query (docs/mcp-tools-spec.md §1): unions character+corp blueprints, resolves location→system, applies item/owner/system/structure/kind/ME/TE filters, optionally collapses identical (type, ME, TE) stacks; totals cover the whole filtered set while only `row_limit` rows are itemized. `below_me`/`below_te` OR'd; `researchable_only` drops reaction formulas. SECURITY INVOKER
- `latest_heartbeats()` — latest completed heartbeat per job per owner, RLS-scoped
- Time-travel/Sheets snapshots as JSON (`as_of` defaults now, reconstructed from SCD-2): `character_asset_snapshot_at`, `character_orders`, `character_industry_jobs`, `character_blueprints`, `corp_assets`, `corp_industry_jobs`, `corp_blueprints` — each taking `character_ids[]` (+ `as_of`, `include_delivered` where applicable)

## Design patterns

- **Anonymous sessions / "is this a real account?":** every visitor is signed in anonymously by the root layout (`src/app/layout/anonymousSession.tsx`, Turnstile-guarded), so a Supabase user existing does **not** mean a member is present — and `is_anonymous` can't be inverted either, since an EVE-SSO-only account stays anonymous forever. Gates call `establishedUser()` (`src/app/account/lib/establishedUser.ts`) instead of `auth.getUser()`; the predicate is the pure `isEstablishedAccount()` next door, twinned in SQL as `is_established_account()` for RLS. See `docs/open-registration.md`.
- **Prefer ramda over `for`/`while`:** sync iteration uses ramda (`map`/`filter`/`reduce`/`pipe`/`chain`/`reject`/`forEach`, …). Sequential async iteration uses `forEachSequential(items, fn)`. Unbounded pagination becomes a small **tail-recursive** async function carrying `(from, acc)` — fetch one page, recurse while full. Canonical shape (prefer over the `for`-loop generator still in `src/buildEsfData.js`, to migrate when next touched):

  ```js
  const readMirror = async (stem, from = 0, acc = []) => {
    const { data, error } = await sde()
      .from(`sde_${stem}`)
      .select('data')
      .order('_key')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`reading sde_${stem} failed: ${error.message}`)
    forEach((row) => acc.push(row.data), data) // ramda forEach, push-mutated accumulator
    return data.length < PAGE_SIZE ? acc : readMirror(stem, from + PAGE_SIZE, acc)
  }
  ```

  Accepted exception: when a `reduce`/`forEach` builds a large array, the accumulator is push-mutated rather than re-spread per item (spreading turns O(n) into O(n^2)). The loop itself still isn't a `for`/`while`.

- **SCD Type 2:** `is_current=true` rows form the current snapshot; `valid_until` is bumped for unchanged rows; a change inserts a new row and closes the old one. Applied to character/corp assets, blueprints, ship (single open row per character), skills (keyed `(registration_id, skill_id)`; never unlearned, so superseded, never closed for vanishing), orders/industry jobs (keyed `order_id`/`job_id`), fittings (keyed `(registration_id, fitting_id)`; an in-client edit opens a new version, a delete closes the row). Vanishing-row semantics differ: a vanished order has filled/expired/cancelled → closed (view holds only open orders); a vanished industry job aged past ESI's `include_completed` window → a **terminal** row (`delivered`/`cancelled`/`reverted`) stays `is_current` (view keeps every job we saw finish), a **non-terminal** one is closed. That window runs ~90 days from _install_, not from delivery, so a job outlasting it (multi-month ME research) vanishes before its `delivered` state is ever observable; leaving those pinned a stale `active` nothing could supersede. The split is the pure `partitionJobs` seam (`src/jobs/industryJobReconcile.js`, shared by both job modules, tested), which assumes a **complete** listing — one response for character (no `x-pages`), `fetchAllPages` for corp.
- **Asset location-walk functions, two shapes:** the `summary`/`contents` functions seed from every asset (whole-hangar aggregate); the `search` functions seed from only the rows matching a filter, so search stays cheap — reuse the seeded-recursion shape for future "look up a few items, walk their tree" functions.
- **Chancellor (admin) accounts:** redeemed an `is_chancellor` invite code. `isChancellor(userId)` checks via service role (RLS only shows a user codes they created). Gates `/account/settings/chancellor`, the impersonate form on `/account/debug`, and on-demand `industry-systems`.
- **Sheets IMPORTDATA:** the `/api/character/*` and `/api/corp/*` routes authenticate via `user_settings.api_token`, call a Postgres function, return CSV.
- **Vercel queue:** only the innomin.at appraisal throttle still uses it (topic `innominate`, consumer `/api/queue/innominate`).
- **Vercel Workflows:** every extract job runs as a Vercel Workflow (`workflow` package; `withWorkflow` wraps `next.config.mjs`, generating gitignored routes under `src/app/.well-known/workflow/`), one file per job under `src/workflows/`.
- **SDE mirror workflow** (`src/workflows/sdeMirror.ts`, logic in `src/jobs/sdeMirror.js`, CLI-runnable with unbounded budget): discovers CCP's current SDE build (the `latest` zip URL 302s to a build-pinned URL carrying `x-sde-build-number`); `planMirror` **skips** (~5s no-op) only when the build is completed by the currently-deployed commit (`currentCommitSha()`, stored in `sde_mirror_state.commit_sha`) **and** <7 days old — a new build, new deployment, or staleness forces a full re-ingest. Ingest is cursor-resumable slices: each step Range-reads only its entry's compressed bytes from the zip (`node:zlib` inflates; no full download), upserting 500-row chunks until its ~35s budget runs out. Files ingest concurrently across bounded lanes (`INGEST_LANES`, assigned largest-first for deterministic replay); each file's slice chain stays sequential. Tables minted at ingest by service-role-only `ensure_sde_mirror_table()` (a new CCP file needs no migration); rows stamped with `sde_build`, stale ones swept. Tail steps start as their inputs land: station names once `sde_npc_stations` drains; `esf_data` once its 7 inputs drain; `sheet_csv` once `sde_types`+`sde_blueprints` drain; finalize last (refreshes `sde_blueprint_product` via `sde_refresh_views()`, marks build completed, closes the heartbeat).
- **MCP server:** `/api/mcp` (`mcp-handler` 2.x over MCP SDK v2; stateless) exposes tools over the extracted data — read-only except the lens writers — registered from five modules sharing plumbing in `lib.ts`:
  - `tools.ts` — `search_assets`, `list_clones`, `list_blueprints`, `list_structures`, `list_industry_jobs`, `list_market_orders`, `search_transactions`, `appraise_items`, SDE-backed `blueprint_for_product`/`blueprints_using_material`. Pure seams `blueprintQuery.ts`/`structureQuery.ts` (no I/O; tested).
  - `estateTools.ts` — `browse_assets` (over the `*_location_summary()`/`_contents()` RPCs; a raw id drills into a container/ship), `appraise_assets` (recursive ISK value of one place; shares the viewer's walk via `collectAssetLines.ts`; skips blueprints; refuses past `MAX_LINES`; pure fold `assetLines.ts`, tested), `wallet_summary`, `list_mercenary_dens`, `list_fittings` (includes shared fits; `include_items` groups modules via the fitting page's `groupForFlag`/`flagSortKey` seam).
  - `industryTools.ts` — `industry_cost_indices` (defaults to caller's structures ∪ watched systems), `list_job_slots` (ceilings from `jobSlots.ts`), `rigs_for_blueprint`.
  - `exploreTools.ts` — static-data exploration: `list_planets` in three exclusive modes (`planet_ids` / `system` / `region`+`planet_type`). Planet types from SDE group 7, never hardcoded. Pure seam `planetQuery.ts` (tested). Reads **only** the public `sde_*` mirror — no bearer client, no `data_refreshed` — but still behind `withMcpAuth`.
  - `lensTools.ts` — lens authoring (docs/sharing-layer/07-lens.md): `lens_schema`, `list_lenses`, `create_lens`, `update_lens` (absent means unchanged). **The only write tools** — they write on the caller's bearer client (RLS pins the row; `update_lens` also filters `user_id`), resolve audience against the caller's corps/alliances (`src/app/lens/audience.ts`, pure, tested), run the editor's `validateLensQuery`, sit behind the `lens` dark-launch flag, and **run the query before writing**, refusing when it returns nothing (zero rows is valid; no data is a failure). Lens resolution: `lensRef.ts` over `match.ts` (id → exact name → unique substring, ambiguity refused). Audience write in `share.ts`, shared with server actions. Deleting stays in the editor.

  Every tool carries `annotations` (`readOnlyHint: true` except the lens writers: `false` + `destructiveHint: false`; `create_lens` `idempotentHint: false`, `update_lens` `true`) — assertions, not enforcement; the RLS-scoped bearer client is what constrains. `openWorldHint` is `false` except the two appraisal tools, the only ones leaving the deployment (they price against innomin.at, sending only item names/quantities). `list_blueprints`/`list_structures` push filters down: the former via the `blueprint_search()` RPC, the latter as `eq`/`ilike`/`in` predicates (only the `services` filter stays in JS — PostgREST can't substring-match inside jsonb arrays). Tools accept fuzzy names (SDE search helpers) and return resolved names plus a `data_refreshed` stamp from `latest_heartbeats()`. `list_market_orders`/`list_industry_jobs` take optional `as_of` (same `parseAtParam` as Sheets `at=`), reconstructing snapshots via the SCD-2 snapshot functions — no grant needed (every `public` function is executable by `anon`/`authenticated` via Postgres defaults + `schema.sql`'s default privileges, which is why `ensure_sde_mirror_table`/`sde_refresh_views` must `revoke execute` to be service-role-only); safe because SECURITY INVOKER.

  The two blueprint tools read only the mirrored SDE and adjust the material bill via `eve-industry` `cost()` modifiers as params (`runs`, `material_efficiency`, `structure`, `rig`, `security`); a monitored `structure_id` derives role bonus, ME rig, and security multiplier from `corp_structure`/`corp_structure_rig` (RLS-scoped), overriding those three. **The rig is gated on applicability** (`rigs.ts`): only a fitted ME rig whose filter covers the product's group/category discounts it; skipped rigs are reported; `blueprints_using_material` reports `rig_applied` per row. `list_structures` deliberately reports **no** derived material bonus (rig value depends on the product; the arithmetic belongs to `cost()`).

  Auth is OAuth 2.1 with Supabase Auth as the authorization server: discovery via `/.well-known/oauth-protected-resource` (RFC 9728), consent at `/oauth/consent`, `withMcpAuth` verifies bearers with `auth.getClaims` (`src/app/api/mcp/auth.ts`). Every query runs on a client carrying the caller's token (`bearer.ts`) so RLS scopes like the cookie session; tools never widen access, never call ESI. Requires Supabase's OAuth 2.1 server enabled (Authorization Path `/oauth/consent`) + dynamic client registration.

- **ESI conditional requests (ETags):** the single-request snapshot jobs (character-orders, -wallet-transactions, -industry-jobs, -fittings) send the last ETag as `If-None-Match` (`esiConditionalJson`). On `304` the job skips its reconcile; on `200` it reconciles and stores the new ETag **after** the write commits, so a mid-run failure never skips a fetch whose data wasn't persisted. Only applied to endpoints returning the whole collection in one request (a `304` unambiguously means nothing changed); paginated endpoints are deliberately unconditional. Each request emits an `esi.conditional_request` metric (`recordEsiConditional` in `src/observability.js`).
- **Observability metrics:** `src/observability.js` emits single-line JSON metrics to stdout, ingested from Vercel function logs — zero-dependency, the single seam to later swap in real OTel.
- **Name resolution:** `universe_name` caches ESI `universeNames`; `resolveBatch()` bisects on error. Type names come from `src/sdeTypes.ts`.
