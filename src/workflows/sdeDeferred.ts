// Stems the nightly sde-mirror deliberately does NOT ingest, because they have
// a schedule of their own.
//
// `map_moons` is the whole reason this file exists. It is by a wide margin the
// largest thing in CCP's export — 344,457 rows and 676 MB, half the mirror's
// total footprint and more than the next four tables combined — and re-ingesting
// it takes roughly ten minutes of the nightly run's wall clock and the bulk of
// its disk IO. Nothing in the app reads `sde_map_moons`: no loader in src/sde*.ts
// touches it, no RPC selects from it, no page renders it. Moon composition also
// changes only when CCP ships a content patch, so a nightly refresh buys nothing
// a weekly one doesn't.
//
// So it moves to its own weekly job (sde-moons, src/workflows/sdeMoons.ts). The
// nightly mirror filters these stems out of its file list; the weekly job selects
// exactly them. Nothing else changes about how the table is written — the same
// per-stem ingest step, the same keyed upserts, and the same per-table stale
// sweep that ingestEntrySlice() runs when an entry completes. That sweep is
// scoped to the one table it just wrote, so a nightly run that never touches
// sde_map_moons never deletes its rows either, and the table simply carries
// whichever sde_build the last weekly run ingested.
//
// Kept as a standalone module with no imports because both workflow files need
// it at their top level, where the workflow compiler bans Node modules — the
// job layer's copy of the stem lives in src/jobs/sdeMoons.js.

export const MOONS_STEM = 'map_moons'

// Every stem the nightly mirror skips. One entry today; the list is the seam
// for the next table that outgrows a nightly re-ingest.
export const DEFERRED_STEMS: readonly string[] = [MOONS_STEM]
