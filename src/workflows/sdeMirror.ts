// The SDE mirror as a Vercel Workflow (the second one after the
// character-implants pilot): a full ingest is far too big for any single 60s
// function invocation, so each step — build discovery, the zip's entry
// listing, every bounded ingest slice, station-name resolution, finalize —
// runs as its own invocation with its own duration budget and Workflows'
// bounded retries. Files ingest concurrently across a bounded pool of lanes
// (safe: each file owns its own sde_<stem> table and reads an immutable
// build-pinned zip), and the tail steps start as soon as the specific files
// they read have landed. All the real work lives in src/jobs/sdeMirror.js (also
// CLI-runnable); every step lazy-imports it because the job module's
// top-level supabase setup needs env vars absent at build time.

import { INGEST_STEPS, type IngestSliceStep, type SdeFile } from './sdeIngestSteps'

type PlanResult = { runId: number; build: number; zipUrl: string }

// Heartbeat start + build discovery. The runId rides through the workflow so
// finalize()'s end heartbeat lands on the same row. The "already mirrored"
// skip check is intentionally omitted: this workflow ALWAYS re-ingests the
// current build, even when CCP's build is unchanged (the CLI path in
// src/jobs/sdeMirror.js keeps its own shouldSkip/--force for manual runs).
async function planRun(): Promise<PlanResult> {
  'use step'
  const { randomInt } = await import('node:crypto')
  const { fetchLatestBuild, markBuildStarted } = await import('@/jobs/sdeMirror.js')
  const { recordHeartbeat } = await import('@/supabase.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('sde-mirror', 'start', { runId, source: 'vercel-workflow' })
  const { build, zipUrl } = await fetchLatestBuild()
  await markBuildStarted(build)
  return { runId, build, zipUrl }
}

async function listFiles(zipUrl: string): Promise<SdeFile[]> {
  'use step'
  const { listEntries } = await import('@/jobs/sdeMirror.js')
  return listEntries(zipUrl)
}

// One bounded slice of one entry: upserts rows until the entry is done
// (returns -1) or the step's time budget runs out (returns the resume cursor).
// Idempotent keyed upserts make the step's bounded retries safe.
//
// This is the GENERIC fallback step, used only for a file whose stem isn't in
// the static INGEST_STEPS roster (a file CCP added since it was generated). The
// common case dispatches to a per-stem named step (ingest_<stem>) so each file
// shows under its own name in Vercel's Workflows observability rather than as a
// wall of identical "ingestSlice" rows — see src/workflows/sdeIngestSteps.ts.
async function ingestSlice(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  const { ingestEntrySlice } = await import('@/jobs/sdeMirror.js')
  return ingestEntrySlice(zipUrl, file, build, startLine)
}

// The named ingest step for a file, or the generic fallback for a stem the
// static roster doesn't know. Deterministic per stem, so a replay resolves the
// same step name it recorded.
const ingestStepFor = (file: SdeFile): IngestSliceStep => INGEST_STEPS[file.stem] ?? ingestSlice

async function stationNames(): Promise<void> {
  'use step'
  const { resolveStationNames } = await import('@/jobs/sdeMirror.js')
  await resolveStationNames()
}

async function finalize(build: number, runId: number): Promise<void> {
  'use step'
  const { finalizeBuild } = await import('@/jobs/sdeMirror.js')
  const { recordHeartbeat } = await import('@/supabase.js')
  await finalizeBuild(build)
  await recordHeartbeat('sde-mirror', 'end', { runId, source: 'vercel-workflow' })
}

// Re-encode the eveship.fit protobuf data into the esf_data table from the
// freshly-mirrored SDE. Its own step (own duration budget + retries), run on
// every mirror pass. force: true re-encodes unconditionally — the nightly run
// always re-does the full ingest (planRun no longer skips), and the ESF encode
// matches that: it re-writes esf_data every night rather than no-opping when
// the build is unchanged. (The manual /api/cron/esf-data route keeps the
// build-guard by default; pass ?force=1 there to match.)
async function encodeEsf(build: number): Promise<void> {
  'use step'
  const { runEsfData } = await import('@/jobs/esfData.js')
  await runEsfData({ build, force: true })
}

// Ingest fan-out sizing: how many per-file slice chains run concurrently.
// Each file writes its own sde_<stem> table, so concurrent lanes share no rows
// and each file's stale-row sweep stays self-contained; the cap is only about
// being polite to CCP's CDN (concurrent Range readers of the same zip) and to
// Supabase's PostgREST (concurrent upsert streams).
const INGEST_LANES = 6

// The sde_* stems encodeEsf() actually reads (the readMirror() calls in
// src/buildEsfData.js) — it can start as soon as these files have fully
// landed, instead of waiting for every entry in the export.
const ESF_INPUT_STEMS = [
  'types',
  'groups',
  'categories',
  'market_groups',
  'dogma_attributes',
  'dogma_effects',
  'type_dogma',
]

// Plain loops rather than the jobs' usual ramda/forEachSequential: the
// orchestrator body is compiled by the workflow directive and should stay
// simple, deterministic control flow over step calls — the cursor a step
// returns is what drives each drain loop, and helpers imported at the top
// level would execute in workflow context rather than inside a step.
//
// Files are ingested in parallel lanes rather than one after another: lane
// assignment is static (largest-first, round-robin), not pulled from a shared
// queue, so the file→step-call mapping is identical on every replay
// regardless of how the runtime resolves in-flight steps. Within a file the
// slice chain stays sequential — each slice's cursor feeds the next.
export async function sdeMirrorWorkflow() {
  'use workflow'
  const plan = await planRun()
  const files = await listFiles(plan.zipUrl)

  // Drain one entry: chase its slice cursor until the entry reports done,
  // through the file's own named step (ingest_<stem>) so the run tree names each
  // file instead of showing a wall of "ingestSlice".
  const drainFile = async (file: SdeFile): Promise<void> => {
    const step = ingestStepFor(file)
    let cursor = 0
    while (cursor !== -1) {
      cursor = await step(plan.zipUrl, file, plan.build, cursor)
    }
  }

  // Largest compressed entries first, so the longest slice chains (typeDogma)
  // start at t=0 and wall clock tracks the longest chain instead of whatever
  // happened to queue behind it.
  const ordered = [...files].sort((a, b) => b.compressedSize - a.compressedSize)
  const lanes: SdeFile[][] = Array.from({ length: INGEST_LANES }, () => [])
  ordered.forEach((file, i) => lanes[i % INGEST_LANES].push(file))

  // Build each lane's sequential drain chain synchronously, keeping a per-file
  // completion promise so the tail steps below can start on their actual
  // inputs rather than on the whole ingest.
  const drained = new Map<string, Promise<void>>()
  const laneDone = lanes.map((lane) => {
    let prev: Promise<void> = Promise.resolve()
    for (const file of lane) {
      prev = prev.then(() => drainFile(file))
      drained.set(file.stem, prev)
    }
    return prev
  })
  const allDrained = Promise.all(laneDone)
  // Wait for specific files; if CCP ever renames one away, degrade to waiting
  // for the full ingest rather than starting a tail step on a missing table.
  const afterStems = (stems: string[]) => Promise.all(stems.map((stem) => drained.get(stem) ?? allDrained))

  // Tail steps overlap the remaining ingest: station-name resolution needs
  // only sde_npc_stations, and the esf_data re-encode (forced — it re-writes
  // every night alongside the full re-ingest) needs only its 7 input tables.
  const stations = afterStems(['npc_stations']).then(() => stationNames())
  const esf = afterStems(ESF_INPUT_STEMS).then(() => encodeEsf(plan.build))

  await Promise.all([allDrained, stations, esf])
  // Last, once every table has landed: refresh the derived views, mark the
  // build completed, and close the heartbeat planRun() opened.
  await finalize(plan.build, plan.runId)
}
