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
- Cron scripts (run via GitHub Actions, see below): `npm run hourly` / `daily` / `assets` / `structures` / `heartbeat`. `connect`, `ping`, `refresh` are DB/token utilities.
- DB migrations (Supabase CLI, configured by `supabase/config.toml`): `npm run db:new <name>` scaffolds a migration under `supabase/migrations/`; `npm run db:push` applies pending migrations to the linked project (`supabase link --project-ref <ref>` first). On push to `main` that touches `supabase/migrations/**`, the `Migrate` workflow runs `supabase db push` automatically (also manually dispatchable).

## Layout

- `src/app/` — Next.js App Router. Page routes: `account/`, `assets/`, `character/`, `industry/`, `market/`, `structures/`, plus `theme/`, `layout/` (Header/Footer), `private/`. Shared helpers at top level: `typeNames.ts`/`typeName.tsx`, `systemNames.ts`, `stationNames.ts`, `isk.ts`, `DateTime.tsx`.
- `src/` (Node cron/scripts): `esi.js` (ESI API wrapper), `supabase.js` (clients — anon + `sudoSupabase` service role that bypasses RLS), `corpWalletJournal.js`, `resolveNames.js`, `structureNames.js`, `tokenRefresh.js`/`refresh.js`, `proxy.ts`, `utils/`. The scheduled job entry points live under `src/jobs/`: `hourly.js`, `daily.js`, `assets.js`, `structures.js` — each exports a `run*` function (callable from the Vercel queue consumer) and self-runs as a CLI when invoked directly (`node src/jobs/<job>.js`).
- `schema.sql` — the single source of truth for the Supabase schema (in the default `public` schema). It's a full reset: it DROPs the app's tables and recreates them, so re-running wipes data — never run it against a database with data you want to keep. To change the schema, edit this file (so a fresh reset stays correct) **and** add a non-destructive incremental migration under `supabase/migrations/` (Supabase CLI format, applied with `supabase db push`) so the change can be rolled out to existing databases without wiping data.
- `.github/workflows/` — `hourly.yml`, `daily.yml`, `assets.yml`, `structures.yml`, `heartbeat.yml` (each a scheduled cron + manual dispatch); `migrate.yml` (applies Supabase migrations on push to `main`).

## Database & ESI

- DB lives in the default `public` Postgres schema in Supabase (so supabase-js calls need no `.schema()` qualifier). Key tables: `registration`, `token`, `asset_over_time` (SCD type-2: `is_current` + `last_seen_at`), `wallet`, `market_transaction`, `industry_job`, `corp_structure`(+`_rig`), `corp_wallet_journal`, `character_corp`, `eve_name`, `structure`, `user_settings`. RLS enforced; cron uses service-role key.
- ESI base `https://esi.evetech.net/latest` via `src/esi.js`. Tokens (eve-sso OAuth) refreshed per character before fetching.
- **Data flow:** ESI → DB (cron scripts) → Next.js server components read DB. Server components must NOT call ESI directly.
- Env vars (`.env.example`): `EVE_CLIENT_ID`/`EVE_SECRET_KEY`/`EVE_CALLBACK_URL`, `SUPABASE_URL`/`SUPABASE_KEY`/`SUPABASE_SERVICE_KEY`/`SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`, Turnstile keys.

# Workflow

- Before committing to a new feature branch, check what branch it branched from and rebase onto the latest upstream of that base (typically `origin/main`) first. This avoids opening PRs that include changes already merged on the base.

# Data sources

- NEVER query the `evesde` SDE schema in the database. That data is out of date and must not be used for any work. Resolve type/name lookups via the external API helper in `src/app/typeNames.ts` (`fetchTypeNames`) instead. If a needed lookup has no non-SDE source, show the raw ID rather than reading the SDE.

# Architecture

- Data from ESI flows into the database (typically via the hourly cron job in `src/jobs/hourly.js`). The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
- Avoid using the `evesde` schema in the database for new work — it can be out of date. Instead, query [eve-build-calculator](https://eve-build-calculator.philihp.com) (e.g. the `https://eve-build-calculator.philihp.com/api/type/${typeID}` pattern in `src/app/typeNames.ts`). It downloads the full SDE but only saves/exposes a curated subset. If the data you need isn't exposed there yet, prefer adding it to eve-build-calculator rather than reaching into the `evesde` schema.
