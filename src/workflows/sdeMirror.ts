// The SDE mirror as a Vercel Workflow (the second one after the
// character-implants pilot): a full ingest is far too big for any single 60s
// function invocation, so each step — build discovery, the zip's entry
// listing, every bounded ingest slice, station-name resolution, finalize —
// runs as its own invocation with its own duration budget and Workflows'
// bounded retries. All the real work lives in src/jobs/sdeMirror.js (also
// CLI-runnable); every step lazy-imports it because the job module's
// top-level supabase setup needs env vars absent at build time.

type SdeFile = { entry: string; stem: string; method: number; compressedSize: number; localOffset: number }

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
async function ingestSlice(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  const { ingestEntrySlice } = await import('@/jobs/sdeMirror.js')
  return ingestEntrySlice(zipUrl, file, build, startLine)
}

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

// Plain loops rather than the jobs' usual ramda/forEachSequential: the
// orchestrator body is compiled by the workflow directive and should stay
// simple, deterministic control flow over step calls — the cursor a step
// returns is what drives the loop, and helpers imported at the top level
// would execute in workflow context rather than inside a step.
export async function sdeMirrorWorkflow() {
  'use workflow'
  const plan = await planRun()
  const files = await listFiles(plan.zipUrl)
  for (const file of files) {
    let cursor = 0
    while (cursor !== -1) {
      cursor = await ingestSlice(plan.zipUrl, file, plan.build, cursor)
    }
  }
  await stationNames()
  await finalize(plan.build, plan.runId)
  // Re-encode the esf_data table from the freshly-mirrored build (forced, so it
  // re-writes every night alongside the full re-ingest above).
  await encodeEsf(plan.build)
}
