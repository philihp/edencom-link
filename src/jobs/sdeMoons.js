// The weekly sde_map_moons ingest, split out of the nightly SDE mirror.
//
// `map_moons` is the largest entry in CCP's export by a wide margin — 344,457
// rows and 676 MB, half the mirror's whole footprint — and nothing in the app
// reads sde_map_moons. Moon composition also only changes on a content patch, so
// re-ingesting it every night spent roughly ten minutes and the bulk of the
// run's disk IO on data that had not changed. It now runs once a week on its own
// schedule; src/workflows/sdeDeferred.ts carries the reasoning and the stem list
// the nightly mirror filters out.
//
// Every building block here is sdeMirror.js's — the same build discovery, entry
// listing, cursor-resumable slices and keyed upserts. ingestEntrySlice() sweeps
// the table's stale rows itself once the entry completes, and that sweep is
// scoped to the one table it just wrote, so a nightly mirror run that never
// touches sde_map_moons never deletes its rows either.
//
// Deliberately does NOT write sde_mirror_state: that row's completed_at and
// commit_sha gate the nightly skip decision, and stamping it from here would
// tell the mirror a build was fully ingested when ~100 of its files were not.
//
// CLI-runnable: `pnpm run sde-moons` ingests moons at CCP's current build with an
// unbounded per-slice budget (the Vercel Workflow, src/workflows/sdeMoons.ts,
// drives the same blocks slice by slice instead).
import { randomInt } from 'node:crypto'

import { recordHeartbeat } from '../supabase.js'
import { cli } from './lib.js'
import { fetchLatestBuild, ingestEntrySlice, listEntries } from './sdeMirror.js'

// The one entry this job owns. Twinned with MOONS_STEM in
// src/workflows/sdeDeferred.ts, which the workflow layer imports instead — a
// workflow file cannot import this module at its top level (the compiler bans
// Node modules there) and these job modules run under plain node, which cannot
// import the TypeScript one.
export const MOONS_STEM = 'map_moons'

export const runSdeMoons = async () => {
  const { build, zipUrl } = await fetchLatestBuild()
  const files = await listEntries(zipUrl)
  const file = files.find((f) => f.stem === MOONS_STEM)
  // A rename or removal upstream should fail loudly rather than quietly leaving
  // the table on a build that keeps ageing.
  if (!file) throw new Error(`sde-moons: no ${MOONS_STEM} entry in SDE build ${build}`)
  await ingestEntrySlice(zipUrl, file, build, 0, Infinity)
  return { build, stem: MOONS_STEM }
}

cli(import.meta.url, 'sde-moons', async () => {
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('sde-moons', 'start', { runId })
  try {
    await runSdeMoons()
  } finally {
    await recordHeartbeat('sde-moons', 'end', { runId })
  }
})
