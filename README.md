# edencom-link

EVE Online hangar/wallet/industry tracker. Pulls character and corporation data from
CCP's ESI API into Postgres (Supabase), then serves it through a Next.js app.

## Prerequisites

- [Node.js](https://nodejs.org/) 24.16.0+ (see `.node-version`)
- [pnpm](https://pnpm.io/) (version is pinned by the `packageManager` field in `package.json`)
- [Docker](https://www.docker.com/) — required to run Supabase locally
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) — already listed as a dev dependency, so `pnpm install` is enough; invoke it via `pnpm exec supabase ...` or `npx supabase ...`
- An [EVE Online developer application](https://developers.eveonline.com/applications) for SSO login (client ID + secret, callback URL)

## 1. Install dependencies

```sh
pnpm install
```

## 2. Start a local Supabase stack

This spins up Postgres, the Supabase API/Auth/Storage services, and Studio in Docker,
all scoped to this repo's `supabase/` directory:

```sh
pnpm exec supabase start
```

The first run downloads Docker images and can take a few minutes. When it finishes it
prints local URLs and keys, including:

- `API URL` — your `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`
- `anon key` — your `SUPABASE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `service_role key` — your `SUPABASE_SERVICE_KEY`
- `Studio URL` — a local dashboard (defaults to `http://localhost:54323`) for browsing
  tables and data while you develop

You can print these again at any time with `pnpm exec supabase status`.

## 3. Load the database schema

The app's schema isn't managed by `supabase db push` for local setup — `schema.sql` at
the repo root is the single source of truth and a full reset. Apply it directly to the
local database (default local connection string shown; get the exact one from
`supabase status` if you changed ports):

```sh
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f schema.sql
```

You can re-run this any time you want to reset local data back to an empty schema.
Incremental migrations under `supabase/migrations/` are for evolving a database that
already has data (e.g. a deployed environment) — a fresh local database doesn't need
them, since `schema.sql` already reflects their combined effect.

## 4. Configure environment variables

Copy the example file and fill in your own values:

```sh
cp .env.example .env
```

- `EVE_CLIENT_ID` / `EVE_SECRET_KEY` / `EVE_CALLBACK_URL` — from your EVE Online
  developer application. Set the callback URL there to match `EVE_CALLBACK_URL`
  (e.g. `http://localhost:3000/character/callback` for local dev), and request at
  least the ESI scopes the extract jobs use (assets, blueprints, wallet, industry
  jobs, location, clones, implants).
- `SUPABASE_PROJECT_REF` — only needed for `pnpm run db:push` against a real hosted
  Supabase project; leave it blank for local-only development.
- `SUPABASE_URL` / `SUPABASE_KEY` / `SUPABASE_SERVICE_KEY` — the `API URL`, `anon key`,
  and `service_role key` printed by `supabase start` (step 2).
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — same API URL and anon
  key, exposed to client components.
- `SUPABASE_USERNAME` / `SUPABASE_PASSWORD` — can be left blank for local development.
- `FLAGS_SECRET` — any base64-encoded 32-byte secret, e.g. `openssl rand -base64 32`.
- `CRON_SECRET` — only used by deployed Vercel Cron; any placeholder value works
  locally since nothing checks it outside of `/api/cron/*` routes.

## 5. Run the app

```sh
pnpm run dev
```

This first runs `predev` (`pnpm run sde:build` + `pnpm run esf:build`), which downloads
CCP's Static Data Export and ship-fitting data into `src/generated/` (gitignored,
skipped on subsequent runs unless you pass `--force`), then starts the Next.js dev
server at `http://localhost:3000`.

Sign in with your EVE Online character to register it, then trigger a manual refresh
from `/character/refresh` to pull data in via the extract jobs (see below) — nothing is
fetched automatically until a job runs.

## Running extract jobs locally

Each ESI endpoint has its own extract job under `src/jobs/`, runnable directly with its
npm script, e.g.:

```sh
pnpm run character-assets
pnpm run character-wallet
pnpm run corp-structures
```

These read tokens from the local database and write results back to it — run the dev
server (or at least sign in once to register a character/token) before running jobs. In
production these are scheduled via Vercel Cron (see `vercel.json` and
`src/app/api/cron/`); locally you run them ad hoc from the CLI or trigger them from the
`/character/refresh` page's "Refresh ESI" buttons, which enqueue the same jobs.

## Other useful commands

- `pnpm run lint` — ESLint
- `pnpm run pretty` — Prettier, formats `src/`
- `pnpm run db:new <name>` — scaffold a new migration under `supabase/migrations/`
- `pnpm exec supabase stop` — stop the local Supabase stack
- `pnpm exec supabase db reset` — drop and recreate the local database from
  `supabase/migrations/` (use `schema.sql` per step 3 instead if you just want a clean
  slate matching the current schema)

There is no automated test suite for this project.
