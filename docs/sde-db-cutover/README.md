# SDE → database cutover: remaining work

The nightly `sde-mirror` Vercel Workflow (merged in
[#607](https://github.com/philihp/edencom-link/pull/607)) mirrors CCP's full
Static Data Export into the `public` schema's `sde_*` tables every day at
12:21 UTC. The app, however, **still downloads the SDE on every build**
(`sde:build` in `predev`/`prebuild`) and reads it from generated JSON via the
in-memory loaders in `src/sde*.ts`. These documents specify the follow-up
pull requests that finish the migration. Each document is a self-contained
implementation spec: do them as **separate PRs, in order**.

| Doc | PR | What | Status / dependency |
|---|---|---|---|
| [00-drop-evesde-schema.md](00-drop-evesde-schema.md) | tiny | Drop the legacy `evesde` Postgres schema | Independent; may already be done — check first |
| [01-loader-cutover.md](01-loader-cutover.md) | PR stack | Rewrite the 5 SDE loaders to read the `sde_*` tables; delete `sde:build` from the build | ✅ **Done** — delivered as an incremental stack (infra+stations #621 → planets #622 → systems #623 → blueprints #624 → types #630 → contract). The contract PR folded in doc 03. |
| [02-sql-name-joins.md](02-sql-name-joins.md) | medium | JOIN SDE names inside the Postgres functions (CSV exports, asset search) | After 01 |
| [03-esf-data-nightly.md](03-esf-data-nightly.md) | optional | Move the ship-fitting `esf:build` off the build too | ✅ **Done** (simpler than the original sketch): `esf:build` reads the `sde_*` mirror at build time instead of downloading CCP's zip — kept a build step, no Vercel Blob. Landed with the contract PR. |
| [04-esf-workflow.md](04-esf-workflow.md) | 2 phases | Schedule the esf encode as a `sde-mirror` workflow step into an `esf_data` table (refresh on a CCP patch without a redeploy) | Phase 1 (encode → `esf_data`, additive) in progress; Phase 2 (serve from DB, retire build step) follows |

## What already exists (build on this, don't reinvent it)

Everything below merged with #607 and is live after the first ingest run:

- **Mirror tables** `public.sde_<snake_case_stem>` — one per JSONL file in
  CCP's export (78 today: `sde_types`, `sde_groups`, `sde_map_solar_systems`,
  `sde_npc_stations`, `sde_blueprints`, `sde_map_planets`, …), each just
  `(_key bigint primary key, data jsonb, sde_build bigint)`. `data` is the raw
  JSONL line (localized names are objects: `data->'name'->>'en'`).
- **App-shaped views** (these are what the app should query — not the raw
  jsonb tables):
  - `sde_published_type(type_id, name, group_id, category_id)` — published,
    named types only; the exact cut `src/generated/sdeTypes.json` has today.
  - `sde_kspace_system(system_id, name, security)` — known-space systems
    (30.0M–31.0M id band), same cut as `sdeSystems.json`.
  - `sde_station(station_id, name, system_id)` — NPC stations joined to their
    ESI-resolved names (`sde_npc_station_name`).
  - `sde_planet(planet_id, system_id, celestial_index, type_id, system_name)`.
- **Materialized view** `sde_blueprint_product(blueprint_type_id, activity_id,
  product_type_id, product_quantity, materials jsonb)` — manufacturing (1) and
  reaction (11) rows only, one per (blueprint, activity, product);
  `materials` is CCP's raw `[{"typeID": n, "quantity": n}, …]` array. Indexed
  on `product_type_id`, `blueprint_type_id`, and GIN `jsonb_path_ops` on
  `materials`. Refreshed by the ingest's finalize step.
- **Search RPCs** `sde_search_type(q text, lim int)` →
  `(type_id, name, group_id, category_id, coverage)` and
  `sde_search_system(q text, lim int)` → `(system_id, name, security,
  coverage)`. Case-insensitive substring, ranked identically to the current
  in-memory search (`coverage = char_length(q) / char_length(name)` DESC,
  shorter name, then id), ILIKE metacharacters escaped, capped at 1000 rows.
- **Access model**: every `sde_*` table/view/MV is readable by `anon` and
  `authenticated` (RLS with a bare `FOR SELECT USING (true)` policy,
  SELECT-only grants) and written **only** by the service-role ingest. App
  code can query them with any Supabase client — no cookie session, no bearer
  token, no `.schema()` qualifier needed.
- **Freshness**: `sde_mirror_state` has one row per CCP build;
  `completed_at IS NOT NULL` means that build fully landed. CCP ships a new
  build per game patch (not nightly), so data changes at most every few weeks.

## House rules (from CLAUDE.md — read it first, these bite)

- **No test runner.** The gates are `pnpm run lint` and `pnpm run build`, plus
  manually exercising the affected pages/routes. Every PR must pass both.
- **Schema changes are dual-write**: edit `schema.sql` (full-reset source of
  truth) **and** add an incremental migration under `supabase/migrations/`
  (`YYYYMMDDHHMMSS_name.sql`; merging to main auto-applies it via the
  `Migrate` GitHub workflow).
- **Ramda over `for`/`while`** for synchronous iteration; sequential async
  iteration uses `forEachSequential` (`src/jobs/lib.js`) in job code. App/TS
  code follows the same spirit.
- **`git fetch origin && git rebase origin/main`** immediately before pushing
  and opening a PR. No exceptions.
- **Never** use Fuzzwork's third-party SDE mirror for anything.
- Pre-commit hooks (husky + lint-staged) auto-format; don't fight them.
- Line numbers in these docs may drift — anchor on the quoted code, not the
  numbers, and re-verify each call site before editing it.
