// The SDE mirror as a Vercel Workflow: a full ingest is far too big for any
// single 60s function invocation, so each step — build discovery, the zip's
// entry listing, the tail encodes, finalize — runs as its own invocation with
// its own duration budget and Workflows' bounded retries.
//
// This run is now an ORCHESTRATOR: it does not ingest anything itself. Each
// file gets its own child workflow run (src/workflows/sdeIngestTable.ts),
// dispatched a bounded INGEST_POOL at a time, and this run waits on their
// terminal status. All the real work lives in src/jobs/sdeMirror.js (also
// CLI-runnable); every step lazy-imports it because the job module's top-level
// supabase setup needs env vars absent at build time.

import { sleep } from 'workflow'

import type { SdeFile } from './sdeIngestSteps'

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

// Start one file's ingest as its own workflow run and return its id. start()
// throws in workflow context (workflow/api resolves to a stub there), so this
// has to be a step — which is also what gets it Node resolution for the child
// workflow module.
async function dispatchTable(zipUrl: string, file: SdeFile, build: number): Promise<string> {
  'use step'
  const { start } = await import('workflow/api')
  const { sdeIngestTableWorkflow } = await import('./sdeIngestTable')
  const run = await start(sdeIngestTableWorkflow, [zipUrl, file, build])
  console.log(`[sde-mirror] ${file.stem}: dispatched run=${run.runId}`)
  return run.runId
}

// One point-in-time read of a child run's status. Deliberately NOT Run.returnValue,
// which polls every second inside the caller — that would pin a function
// invocation for the whole of mapMoons' quarter hour. The orchestrator sleeps
// between these instead, so it is suspended rather than billed while it waits.
async function tableRunStatus(runId: string): Promise<string> {
  'use step'
  const { getRun } = await import('workflow/api')
  return getRun(runId).status
}

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
// match the re-ingest.
async function encodeSheets(build: number): Promise<void> {
  'use step'
  const { runSheetCsv } = await import('@/jobs/sheetCsv.js')
  await runSheetCsv({ build, force: true })
}

// How many per-file ingest RUNS are in flight at once. This is the only knob
// that sets the mirror's peak disk IO, so it is deliberately below the six
// lanes whose concurrent upsert streams exhausted the IO budget on 2026-09-10.
// The nightly mirror has all night; widening this to save wall clock trades a
// resource we have for one we ran out of.
const INGEST_POOL = 4

// How long the orchestrator sleeps between status reads of its in-flight child
// runs. Long enough that a quarter-hour file costs tens of polls rather than
// hundreds, short enough that the hundred small files don't each idle a minute
// after finishing. sleep() suspends the run via a timer event — it does not
// hold an invocation.
const POLL_INTERVAL = '20s'

// Terminal child-run statuses, per @workflow/world. Anything else ('pending',
// 'running') means keep waiting.
const isDone = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled'

// Plain loops rather than the jobs' usual ramda/forEachSequential: the
// orchestrator body is compiled by the workflow directive and should stay
// simple, deterministic control flow over step calls — and helpers imported at
// the top level would execute in workflow context rather than inside a step.
//
// Lane assignment is static (largest-first, round-robin), not pulled from a
// shared queue, so the file→step-call mapping is identical on every replay
// regardless of how the runtime resolves in-flight steps.
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

    // Run one file as its own child workflow: dispatch it, then wait on its
    // terminal status. A failed or cancelled child throws here, which the lane
    // chain below catches and collects like any other file failure.
    const runTable = async (file: SdeFile): Promise<void> => {
      const childRunId = await dispatchTable(plan.zipUrl, file, plan.build)
      for (;;) {
        await sleep(POLL_INTERVAL)
        const status = await tableRunStatus(childRunId)
        if (status === 'completed') return
        if (isDone(status)) throw new Error(`ingest run ${childRunId} ${status}`)
      }
    }

    // Per-file fault isolation: a file whose slices exhaust their bounded step
    // retries should cost that file, not the other hundred files' committed
    // work. Failures are collected and thrown together after everything else
    // drains, so the run still reads failed and completed_at is never stamped.
    const failures: { stem: string; message: string }[] = []
    const caught = (stem: string, p: Promise<void>): Promise<void> =>
      p.catch((e) => {
        console.error(`[sde-mirror] ${stem} failed:`, e)
        failures.push({ stem, message: e instanceof Error ? e.message : String(e) })
      })

    // Largest compressed entries first, so the longest chains (mapMoons, types)
    // start at t=0 and wall clock tracks the longest chain instead of whatever
    // happened to queue behind it.
    const ordered = [...files].sort((a, b) => b.compressedSize - a.compressedSize)
    const lanes: SdeFile[][] = Array.from({ length: INGEST_POOL }, () => [])
    ordered.forEach((file, i) => lanes[i % INGEST_POOL].push(file))

    // Each lane dispatches its files one after another, so at most INGEST_POOL
    // child runs exist at any moment. Built synchronously so the step-call
    // order is fixed for replay.
    const laneDone = lanes.map((lane) => {
      let prev: Promise<void> = Promise.resolve()
      for (const file of lane) {
        prev = prev.then(() => caught(file.stem, runTable(file)))
      }
      return prev
    })
    await Promise.all(laneDone)

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
        `sde-mirror: ${failures.length} file(s) failed: ${failures.map(({ stem }) => stem).join(', ')}`
      )
    }

    // The tail encodes read the mirror back, and they run ONLY once every file
    // has landed — one after another, with no ingest still writing underneath
    // them. They used to start as soon as their own input tables drained, which
    // put a full-table read of sde_types (220 MB) against a database still
    // absorbing the other ~90 files; that read blew its statement timeout every
    // night from 2026-08-31 onward, which is what kept completed_at null and
    // forced the next night into another full re-ingest. Serialising them here
    // costs a few minutes of wall clock we have and removes the contention.
    await stationNames()
    await encodeEsf(plan.build)
    await encodeSheets(plan.build)

    // Last: refresh the derived views, stamp the build completed with this
    // run's commit, and close the heartbeat planRun() opened.
    await finalize(plan.build, plan.runId, plan.commit)
  } catch (e) {
    await finalizeFailed(plan.runId, e instanceof Error ? e.message : String(e))
    throw e
  }
}
