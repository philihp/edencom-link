// One SDE file's ingest as its own Vercel Workflow run.
//
// The mirror used to drain every file inside the single sde-mirror run, six
// lanes wide. That put six concurrent upsert streams and the tail encoders on
// the database at once, and on 2026-09-10 the resulting disk IO exhausted the
// instance's budget and took Postgres down for four and a half hours. Splitting
// each file into its own run buys three things the lanes could not:
//
//   - The orchestrator dispatches at a deliberate width (INGEST_POOL) rather
//     than however many lanes happened to be configured, and the width is now
//     the only knob controlling peak IO.
//   - A file that exhausts its retries fails its own run. The parent sees a
//     terminal status instead of inheriting a rejected promise mid-lane, and
//     the other hundred files' committed work is untouched.
//   - Vercel's Workflows view lists one run per table, so "which table is slow"
//     is a glance rather than a log dig.
//
// Within a run the slice chain stays strictly sequential: each slice's returned
// cursor feeds the next, exactly as before. There is no deadline to race — the
// nightly mirror has all night — so nothing here tries to widen that chain.

import { INGEST_STEPS, type IngestSliceStep, type SdeFile } from './sdeIngestSteps'

// The GENERIC fallback slice step, used only for a file whose stem isn't in the
// static INGEST_STEPS roster (a file CCP added since it was generated). The
// common case dispatches to the per-stem named step (ingest_<stem>) so each
// file shows under its own name rather than as a wall of identical rows.
async function ingestSlice(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  const { ingestEntrySlice } = await import('@/jobs/sdeMirror.js')
  return ingestEntrySlice(zipUrl, file, build, startLine)
}

// Deterministic per stem, so a replay resolves the same step name it recorded.
const ingestStepFor = (file: SdeFile): IngestSliceStep => INGEST_STEPS[file.stem] ?? ingestSlice

// Drain one entry: chase its slice cursor until the entry reports done (-1),
// through the file's own named step. Idempotent keyed upserts make each slice's
// bounded retries safe. A slice returning the cursor it was given can't happen
// today (a pause line is always past startLine), but if a regression ever makes
// it possible, fail the run rather than spawning steps forever.
export async function sdeIngestTableWorkflow(zipUrl: string, file: SdeFile, build: number): Promise<void> {
  'use workflow'
  const step = ingestStepFor(file)
  let cursor = 0
  while (cursor !== -1) {
    const next = await step(zipUrl, file, build, cursor)
    if (next === cursor) throw new Error(`sde-mirror: ${file.stem} made no progress at line ${cursor}`)
    cursor = next
  }
}
