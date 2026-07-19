# PR 4: move the ESF build into the SDE pipeline (Transform → serve → contract)

**Status: Phase 1 in progress.** Doc 03 moved `esf:build` off CCP's zip onto
the `sde_*` mirror but kept it a build-time step writing `public/esf-data/*.pb2`
— which every preview deploy re-runs, costing build time and money. This doc
retires it in three PRs, each deployed and validated before the next:

1. **Transform** — a workflow step after all the SDE extracts encodes the six
   protobuf files into a new `esf_data` table.
2. **Serve** — a route serves those rows as if they were static files, with
   ETag/Last-Modified conditional-request handling and heavy CDN caching.
3. **Contract** — remove the old ESF build job from the build.

## Phase 1 — Transform: encode into `esf_data` from the workflow (PR 1)

Purely additive. The live ship-fit wheel keeps being served by the build-time
static files (`public/esf-data/`), so there is zero regression window.

- **`esf_data` table** (`schema.sql` + `supabase/migrations/20260718120000_add_esf_data.sql`):
  `(name text pk, data text, sde_build bigint, updated_at timestamptz)`. `data`
  is the base64-encoded protobuf bytes (text is far simpler to move through
  PostgREST than bytea; the Phase 2 route base64-decodes it). Public-read RLS
  (non-sensitive static game data, same access model as the `sde_*` mirror);
  writes are service-role only.
- **`encodeEsfData()`** (`src/buildEsfData.js`): refactored out of the build
  step's `run()` — reads the mirror, applies the eveship.fit patches, and
  returns `{ [fileName]: Buffer }` without touching disk. `run()` (the
  `predev`/`prebuild` step) now calls it and writes the buffers to
  `public/esf-data/`; the module only self-runs `run()` when invoked as a CLI,
  so importing it for the job doesn't trigger a build.
- **`runEsfData()`** (`src/jobs/esfData.js`, `pnpm run esf-data`): encodes via
  `encodeEsfData()`, base64-encodes each buffer, and upserts the six rows into
  `esf_data` stamped with `sde_build` (the build the workflow just ingested, or
  the latest completed build for a CLI run) via the service role.
- **Workflow step** (`src/workflows/sdeMirror.ts`): a new `encodeEsf(build)`
  `'use step'` runs after `finalize` — its own duration budget + bounded
  retries, and deliberately *after* finalize so an encode failure can't hold
  back the mirror completion the rest of the app reads.

**Bootstrap:** the nightly workflow only reaches `encodeEsf` after a full
ingest, and it skips ingesting when CCP's current build is already mirrored —
so a freshly-migrated `esf_data` table stays empty until CCP ships a new build.
Populate it once via the manual `CRON_SECRET`-protected `/api/cron/esf-data`
route (runs `runEsfData()` against the current mirror; idempotent), or
`pnpm run esf-data` locally. **Do this immediately after this PR deploys** —
with Phase 2 folded into the same PR (#635 merged into it), the wheel points
at `/esf/` as soon as it deploys and 404s until the table is populated.

## Phase 2 — Serve: a route that acts like static files (PR 2)

Prerequisite: `esf_data` populated in production (trigger the workflow once).

- Add a `/esf/[file]` route that streams the base64-decoded bytes from
  `esf_data`. It must sit at a **new** path: the build-time static files still
  occupy `/esf-data/` and Vercel serves `public/` assets ahead of route
  handlers, so a same-path route would be shadowed and unvalidatable.
- Cache signals: `ETag` keyed on `sde_build` and `Last-Modified` from
  `updated_at`, honoring `If-None-Match`/`If-Modified-Since` with a `304`; a
  `Cache-Control` with a long `s-maxage` + `stale-while-revalidate` so Vercel's
  CDN keeps serving it hot, and a modest browser `max-age` so a patched SDE
  propagates via revalidation.
- Flip `EveDataProvider`'s `dataUrl` to `/esf/` (`src/app/ship/[itemId]/
  shipFitView.tsx`) so the preview deploy validates the wheel against the
  DB-served data end-to-end.

## Phase 3 — Contract: remove the ESF build job from the build (PR 3) ✅ done

`public/esf-data/` was unread once the wheel moved to `/esf/`:

- Dropped `esf:build` from `predev`/`prebuild` and removed the script, `run()`,
  and the `public/esf-data/` output (and its `.gitignore` entry).
  `encodeEsfData()` stays — it's the cron/workflow job's encode.
- The build now neither downloads nor encodes anything from the SDE, so preview
  and production deploys stop paying for it. The ESF data is refreshed only by
  the nightly `sde-mirror` workflow's `encodeEsf` step — the final step of that
  job, run on every pass (including the build-unchanged skip path). No separate
  cron; `/api/cron/esf-data` remains as an unscheduled manual bootstrap.
