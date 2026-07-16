// The SDE mirror as a Vercel Workflow (the second one after the
// character-implants pilot): a full ingest is far too big for any single 60s
// function invocation, so each step — build discovery, the zip's entry
// listing, every bounded ingest slice, station-name resolution, finalize —
// runs as its own invocation with its own duration budget and Workflows'
// bounded retries. All the real work lives in src/jobs/sdeMirror.js (also
// CLI-runnable); every step lazy-imports it because the job module's
// top-level supabase setup needs env vars absent at build time.

type SdeFile = { entry: string; stem: string; method: number; compressedSize: number; localOffset: number }

type PlanResult = { skipped: true } | { skipped: false; runId: number; build: number; zipUrl: string }

// Heartbeat start + build discovery + skip check. The runId rides through the
// workflow so finalize()'s end heartbeat lands on the same row; on the
// skip path the pair closes right here.
async function planRun(force: boolean): Promise<PlanResult> {
  'use step'
  const { randomInt } = await import('node:crypto')
  const { fetchLatestBuild, shouldSkip, markBuildStarted } = await import('@/jobs/sdeMirror.js')
  const { recordHeartbeat } = await import('@/supabase.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('sde-mirror', 'start', { runId, source: 'vercel-workflow' })
  const { build, zipUrl } = await fetchLatestBuild()
  if (!force && (await shouldSkip(build))) {
    console.log(`[sde-mirror] build ${build} already mirrored, skipping`)
    await recordHeartbeat('sde-mirror', 'end', { runId, source: 'vercel-workflow' })
    return { skipped: true }
  }
  await markBuildStarted(build)
  return { skipped: false, runId, build, zipUrl }
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

// Plain loops rather than the jobs' usual ramda/forEachSequential: the
// orchestrator body is compiled by the workflow directive and should stay
// simple, deterministic control flow over step calls — the cursor a step
// returns is what drives the loop, and helpers imported at the top level
// would execute in workflow context rather than inside a step.
export async function sdeMirrorWorkflow({ force = false }: { force?: boolean } = {}) {
  'use workflow'
  const plan = await planRun(force)
  if (plan.skipped) return
  const files = await listFiles(plan.zipUrl)
  for (const file of files) {
    let cursor = 0
    while (cursor !== -1) {
      cursor = await ingestSlice(plan.zipUrl, file, plan.build, cursor)
    }
  }
  await stationNames()
  await finalize(plan.build, plan.runId)
}
