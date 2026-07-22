# PR 3: run it nightly as a tail step of the `sde-mirror` workflow

## Goal

The CSVs regenerate automatically every night, immediately after the SDE
tables they read have landed — same trigger discipline as the `encodeEsf`
step. **No new cron entry and no new workflow:** the job rides the existing
`sde-mirror` run (12:21 UTC).

## Change

All in `src/workflows/sdeMirror.ts`, mirroring `encodeEsf` exactly:

1. A new step function:

   ```ts
   async function encodeSheets(build: number): Promise<void> {
     'use step'
     const { runSheetCsv } = await import('@/jobs/sheetCsv.js')
     await runSheetCsv({ build, force: true })
   }
   ```

   `force: true` for the same reason `encodeEsf` passes it: the nightly
   workflow always re-ingests the current build, and the derived data
   re-encodes to match, rather than no-opping on an unchanged build number.
   (The manual `/api/cron/sheet-csv` route keeps the build-guard by default.)

2. Its input stems:

   ```ts
   const SHEET_INPUT_STEMS = ['types', 'blueprints']
   ```

3. In the orchestrator body, alongside the existing tail steps:

   ```ts
   const sheets = afterStems(SHEET_INPUT_STEMS).then(() => encodeSheets(plan.build))
   // …
   await Promise.all([allDrained, stations, esf, sheets])
   ```

   `afterStems` already degrades to "wait for the full ingest" if CCP ever
   renames a file away, so no extra guard is needed. The step runs
   concurrently with `encodeEsf` (which also waits on `types`, among others) —
   both only read the mirror and write disjoint tables, so ordering between
   them doesn't matter; `finalize` still runs last.

## Determinism note

The workflow body is replayed — keep the addition to simple, static control
flow like the existing tail steps (no shared queues, no timers). A fixed
promise chained off `afterStems` matches the established pattern.

## Verification

- Trigger a run manually (`/api/cron/sde-mirror` with the CRON secret) or wait
  for the nightly; watch Observability → Workflows for the new `encodeSheets`
  step succeeding after the `types`/`blueprints` slice chains and before
  `finalize`.
- `sheet_csv.sde_build` equals the run's build for all five rows afterward.
- Confirm the step's duration fits its budget comfortably (expected: a few
  seconds of paging + string building; the ESF encode is the heavier sibling
  and already fits).
