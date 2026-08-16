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

type PlanResult = { runId: number; build: number; zipUrl: string; commit: string; skip: boolean }

// Heartbeat start + build discovery + the skip decision (planMirror). skip is
// true only when CCP's build is unchanged, the currently-deployed commit already
// produced this mirror, and it's < 7 days old — in which case the workflow does
// nothing but close the heartbeat (finalizeSkipped), the ~5 s no-op run we want
// in steady state. Any of a new SDE build, a new code deployment, or data older
// than 7 days makes skip false and forces the full ingest below. markBuildStarted
// only when we're actually going to ingest (the row already exists on a skip).
async function planRun(): Promise<PlanResult> {
  'use step'
  const { randomInt } = await import('node:crypto')
  const { planMirror, markBuildStarted } = await import('@/jobs/sdeMirror.js')
  const { recordHeartbeat } = await import('@/supabase.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('sde-mirror', 'start', { runId, source: 'vercel-workflow' })
  try {
    const { build, zipUrl, commit, skip } = await planMirror()
    if (!skip) await markBuildStarted(build)
    return { runId, build, zipUrl, commit, skip }
  } catch (e) {
    // This step owns the only runId that exists so far, so nothing downstream
    // could close the heartbeat it just opened — do it here, or /jobs reads a
    // run that never ended (see finalizeFailed).
    await recordHeartbeat('sde-mirror', 'end', {
      runId,
      source: 'vercel-workflow',
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
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

async function finalize(build: number, runId: number, commit: string): Promise<void> {
  'use step'
  const { finalizeBuild } = await import('@/jobs/sdeMirror.js')
  const { recordHeartbeat } = await import('@/supabase.js')
  await finalizeBuild(build, commit)
  await recordHeartbeat('sde-mirror', 'end', { runId, source: 'vercel-workflow', ok: true })
}

// The failure path, and the reason /jobs could report "last run 20 days ago"
// while the cron fired every night: the heartbeat is opened by planRun and
// closed only at the end, so a run that died mid-ingest left it open forever
// and latest_heartbeats() (ended_at is not null) kept answering with the last
// run that reached finalize. Closing it with ok: false makes the same page read
// "failed", and rows.ts renders the message. Its own step so the failing run
// still gets it recorded; the workflow rethrows afterwards, so the run is
// failed in Observability either way.
async function finalizeFailed(runId: number, message: string): Promise<void> {
  'use step'
  const { recordHeartbeat } = await import('@/supabase.js')
  await recordHeartbeat('sde-mirror', 'end', { runId, source: 'vercel-workflow', ok: false, error: message })
}

// The skip path: nothing changed (same build, same deployed commit, < 7 days
// old), so just close the heartbeat planRun() opened and return — no ingest, no
// view refresh, no ESF re-encode. Crucially it does NOT touch completed_at, so
// the 7-day staleness backstop keeps counting from the last real ingest.
async function finalizeSkipped(build: number, runId: number): Promise<void> {
  'use step'
  const { recordHeartbeat } = await import('@/supabase.js')
  await recordHeartbeat('sde-mirror', 'end', { runId, source: 'vercel-workflow', ok: true })
  console.log(`[sde-mirror] build ${build}: unchanged build + deployment, fresh (< 7 days) — skipping`)
}

// Re-encode the eveship.fit protobuf data into the esf_data table from the
// freshly-mirrored SDE. Its own step (own duration budget + retries). Only
// reached on a NON-skipped run (new build, new deployment, or the 7-day
// refresh), where something the encode depends on may have changed — so
// force: true re-encodes unconditionally to match the re-ingest, rather than
// trusting esf_data's own build-guard. (A skipped run returns before this, so
// the ESF data is left as-is, which is correct: nothing it reads changed.)
async function encodeEsf(build: number): Promise<void> {
  'use step'
  const { runEsfData } = await import('@/jobs/esfData.js')
  await runEsfData({ build, force: true })
}

// Re-encode the industry spreadsheet's static CSVs into the sheet_csv table from
// the freshly-mirrored SDE. Its own step (own duration budget + retries), and
// like encodeEsf only reached on a non-skipped run, so force: true re-encodes to
// match the re-ingest. Reads only sde_types + sde_blueprints, so it starts as
// soon as those two files have landed (see SHEET_INPUT_STEMS).
async function encodeSheets(build: number): Promise<void> {
  'use step'
  const { runSheetCsv } = await import('@/jobs/sheetCsv.js')
  await runSheetCsv({ build, force: true })
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

// The sde_* stems encodeSheets() reads (buildSheets in src/buildSheetCsv.js) —
// it can start as soon as these two files have landed.
const SHEET_INPUT_STEMS = ['types', 'blueprints']

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
  // Everything from here on is wrapped so that a run which dies mid-ingest
  // still closes the heartbeat planRun() opened (finalizeFailed) before the
  // error is rethrown. Without that the run is invisible to /jobs, which reads
  // latest_heartbeats() — completed runs only — and so reports the last
  // *successful* run's age no matter how many nights have failed since.
  try {
    // Steady state: CCP's build is unchanged, this deployment already produced
    // the mirror, and it's < 7 days old. Close out in one cheap step and stop.
    if (plan.skip) {
      await finalizeSkipped(plan.build, plan.runId)
      return
    }
    const files = await listFiles(plan.zipUrl)

    // Drain one entry: chase its slice cursor until the entry reports done,
    // through the file's own named step (ingest_<stem>) so the run tree names
    // each file instead of showing a wall of "ingestSlice". A slice returning
    // the cursor it was given can't happen today (a pause line is always past
    // startLine), but if a regression ever makes it possible, fail the file
    // rather than spawning steps forever.
    const drainFile = async (file: SdeFile): Promise<void> => {
      const step = ingestStepFor(file)
      let cursor = 0
      while (cursor !== -1) {
        const next = await step(plan.zipUrl, file, plan.build, cursor)
        if (next === cursor) throw new Error(`sde-mirror: ${file.stem} made no progress at line ${cursor}`)
        cursor = next
      }
    }

    // Per-file fault isolation (the characterAssets catch-collect shape): a
    // file whose slices exhaust their bounded step retries should cost that
    // file — and any tail step reading it — not the other 100 files' committed
    // work. Failures are collected and thrown together after everything else
    // drains, so the run still reads failed and completed_at is never stamped.
    const failures: { stem: string; message: string }[] = []
    const caught = (stem: string, p: Promise<void>): Promise<void> =>
      p.catch((e) => {
        console.error(`[sde-mirror] ${stem} failed:`, e)
        failures.push({ stem, message: e instanceof Error ? e.message : String(e) })
      })

    // Largest compressed entries first, so the longest slice chains (typeDogma)
    // start at t=0 and wall clock tracks the longest chain instead of whatever
    // happened to queue behind it.
    const ordered = [...files].sort((a, b) => b.compressedSize - a.compressedSize)
    const lanes: SdeFile[][] = Array.from({ length: INGEST_LANES }, () => [])
    ordered.forEach((file, i) => lanes[i % INGEST_LANES].push(file))

    // Build each lane's sequential drain chain synchronously, keeping a per-file
    // completion promise so the tail steps below can start on their actual
    // inputs rather than on the whole ingest. The drained map holds the
    // UNCAUGHT per-file promise — a tail step whose input failed must reject,
    // not run over a half-ingested table — while the lane chains on the caught
    // continuation so it proceeds past a failed file to its lane-mates.
    const drained = new Map<string, Promise<void>>()
    const laneDone = lanes.map((lane) => {
      let prev: Promise<void> = Promise.resolve()
      for (const file of lane) {
        const attempt = prev.then(() => drainFile(file))
        drained.set(file.stem, attempt)
        prev = caught(file.stem, attempt)
      }
      return prev
    })
    const allDrained = Promise.all(laneDone)
    // Wait for specific files; if CCP ever renames one away, degrade to waiting
    // for the full ingest rather than starting a tail step on a missing table.
    const afterStems = (stems: string[]) => Promise.all(stems.map((stem) => drained.get(stem) ?? allDrained))

    // Tail steps overlap the remaining ingest: station-name resolution needs
    // only sde_npc_stations, the esf_data re-encode needs only its 7 input
    // tables, and the sheet_csv re-encode needs only sde_types + sde_blueprints.
    // All are forced — a non-skipped run always re-does the full ingest, and the
    // derived encodes re-write to match. Each is caught like the files are: a
    // failed input file rejects its afterStems, so the tail step is skipped and
    // recorded as its own failure (alongside the file's) instead of running
    // over a half-ingested table or killing the run.
    const stations = caught(
      'station_names',
      afterStems(['npc_stations']).then(() => stationNames())
    )
    const esf = caught(
      'esf_data',
      afterStems(ESF_INPUT_STEMS).then(() => encodeEsf(plan.build))
    )
    const sheets = caught(
      'sheet_csv',
      afterStems(SHEET_INPUT_STEMS).then(() => encodeSheets(plan.build))
    )

    await Promise.all([allDrained, stations, esf, sheets])
    // A partial ingest must not finalize: no view refresh over half-ingested
    // tables, no completed_at stamp (so the next night re-ingests). Throwing
    // lands in the catch below — finalizeFailed closes the heartbeat ok: false
    // and the rethrow marks the run failed in Observability — while everything
    // that did land stays committed.
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ stem, message }) => new Error(`${stem}: ${message}`)),
        // The message is what finalizeFailed records and /jobs renders, so
        // name the casualties rather than just counting them.
        `sde-mirror: ${failures.length} step(s) failed: ${failures.map(({ stem }) => stem).join(', ')}`
      )
    }
    // Last, once every table has landed: refresh the derived views, stamp the
    // build completed with this run's commit, and close the heartbeat planRun()
    // opened.
    await finalize(plan.build, plan.runId, plan.commit)
  } catch (e) {
    await finalizeFailed(plan.runId, e instanceof Error ? e.message : String(e))
    throw e
  }
}
