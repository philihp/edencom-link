# PR 4: schedule `esf:build` as a workflow step (esf_data table)

**Status: Phase 1 in progress.** Doc 03 moved `esf:build` off CCP's zip onto
the `sde_*` mirror but kept it a build-time step writing `public/esf-data/*.pb2`.
This doc finishes the idea the repo owner picked ("do it as A"): encode the six
protobuf files **inside the nightly `sde-mirror` workflow** right after a new SDE
build lands, storing them in a Postgres table so the ship-fitting data refreshes
on a CCP patch **without a redeploy**.

The change is split into two phases so the live wheel never regresses.

## Phase 1 — additive: encode into `esf_data` from the workflow (this PR)

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

Populate the table once by triggering the workflow manually (the
`CRON_SECRET`-protected `/api/cron/sde-mirror` route, or `pnpm run sde-mirror`
locally followed by `pnpm run esf-data`).

## Phase 2 — flip serving to the DB (follow-up PR)

Once `esf_data` is populated in production:

- Add a `/esf-data/[file]` route that streams the base64-decoded bytes from
  `esf_data` with cache headers/ETag keyed on `sde_build` (so a patched SDE
  busts browser caches). A route can't coexist with a static file at the same
  path, which is why the flip is its own phase.
- Retire the build-time `esf:build` (`predev`/`prebuild`) and stop committing/
  writing `public/esf-data/`. The build then downloads nothing **and** encodes
  nothing from the SDE — the `dataUrl="/esf-data/"` prop is unchanged because
  the route answers at the same path.
