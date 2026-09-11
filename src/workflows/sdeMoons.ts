// The weekly sde_map_moons ingest, split out of the nightly mirror.
//
// Same machinery as any other table — the per-stem `ingest_map_moons` step,
// cursor-resumable slices, keyed upserts, and the per-table stale sweep that
// ingestEntrySlice() runs when the entry completes — just on its own schedule
// and with its own heartbeat. See src/workflows/sdeDeferred.ts for why this one
// table earns a separate job.
//
// It does NOT share sde_mirror_state with the nightly run. That row's
// completed_at and commit_sha gate the nightly skip decision (shouldSkipMirror),
// and a weekly job stamping it would tell the mirror a build had been fully
// ingested when ~100 of its files had not. This job discovers the current build,
// ingests moons at it, and records nothing but a heartbeat.

import { INGEST_STEPS, type SdeFile } from './sdeIngestSteps'
import { MOONS_STEM } from './sdeDeferred'

type MoonsPlan = { runId: number; build: number; zipUrl: string; file: SdeFile | null }

// Heartbeat start + build discovery + locating the one entry we want. There is
// no skip decision: the job runs weekly precisely so it can be unconditional,
// and a re-ingest of an unchanged build is idempotent anyway.
async function planMoons(): Promise<MoonsPlan> {
  'use step'
  const { randomInt } = await import('node:crypto')
  const { fetchLatestBuild, listEntries } = await import('@/jobs/sdeMirror.js')
  const { recordHeartbeat } = await import('@/supabase.js')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('sde-moons', 'start', { runId, source: 'vercel-workflow' })
  try {
    const { build, zipUrl } = await fetchLatestBuild()
    const files: SdeFile[] = await listEntries(zipUrl)
    return { runId, build, zipUrl, file: files.find((f) => f.stem === MOONS_STEM) ?? null }
  } catch (e) {
    // This step owns the only runId that exists so far, so nothing downstream
    // could close the heartbeat it just opened — do it here, or /jobs reads a
    // run that never ended.
    await recordHeartbeat('sde-moons', 'end', {
      runId,
      source: 'vercel-workflow',
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

async function finishMoons(runId: number): Promise<void> {
  'use step'
  const { recordHeartbeat } = await import('@/supabase.js')
  await recordHeartbeat('sde-moons', 'end', { runId, source: 'vercel-workflow', ok: true })
}

// Closing the heartbeat ok: false is what makes /jobs read "failed" instead of
// reporting the last *successful* run's age — latest_heartbeats() only sees
// completed runs, so an open heartbeat is invisible to it.
async function failMoons(runId: number, message: string): Promise<void> {
  'use step'
  const { recordHeartbeat } = await import('@/supabase.js')
  await recordHeartbeat('sde-moons', 'end', { runId, source: 'vercel-workflow', ok: false, error: message })
}

// Plain loop rather than the jobs' usual ramda: the orchestrator body is
// compiled by the workflow directive and should stay simple, deterministic
// control flow over step calls.
export async function sdeMoonsWorkflow() {
  'use workflow'
  const plan = await planMoons()
  try {
    // CCP renaming or dropping the entry should fail loudly rather than silently
    // leaving the table on a build that keeps ageing.
    if (plan.file === null) throw new Error(`sde-moons: no ${MOONS_STEM} entry in SDE build ${plan.build}`)
    const step = INGEST_STEPS[MOONS_STEM]
    if (step === undefined) throw new Error(`sde-moons: no ingest step registered for ${MOONS_STEM}`)

    // Sequential slice chain: each slice's returned cursor feeds the next, and
    // the entry reports -1 when it is done (having swept its own stale rows).
    // A slice returning the cursor it was given can't happen today, but if a
    // regression ever makes it possible, fail rather than spawning steps forever.
    let cursor = 0
    while (cursor !== -1) {
      const next = await step(plan.zipUrl, plan.file, plan.build, cursor)
      if (next === cursor) throw new Error(`sde-moons: ${MOONS_STEM} made no progress at line ${cursor}`)
      cursor = next
    }
    await finishMoons(plan.runId)
  } catch (e) {
    await failMoons(plan.runId, e instanceof Error ? e.message : String(e))
    throw e
  }
}
