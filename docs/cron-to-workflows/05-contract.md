# Phase 5: contract — retire the old scheduled plumbing, settle the queue's fate

After phases 1–4, every scheduled extract job `start()`s a workflow. This
phase deletes what that stranded and makes the one real remaining
decision: what happens to the on-demand "Refresh ESI" path.

## 1. Delete the dead cron helpers

In `src/utils/cron.ts`, nothing references these anymore — remove them:

- `runDirectCronJob` (phase 1 orphaned it)
- `dispatchAccountCronJob` (phase 2)
- `fanOutPerCharacterCronJob` / `fanOutPerCharacterAnyScopeCronJob`
  (phase 3) — **but check the `character-implants` manual trigger route
  first**; it still calls `fanOutPerCharacterCronJob` (see §3)
- `fanOutPerCorporationCronJob` (phase 4)

`requireCronSecret` stays — every cron route still uses it.

## 2. Decide the on-demand path (recommendation: migrate it too)

Today `dispatchRefresh.ts` / `dispatchSingleJob` send queue messages, and
the consumer at `/api/queue/jobs` runs jobs inline with `refresh_task`
status tracking. Two coherent end states:

**(a) Keep the queue for on-demand** — zero further work. Cost: every job
permanently has two execution paths, the consumer's `JOBS` registry and
its 60s cap live forever, and the [`/workflow` page plan](../workflow-jobs-page.md)'s
"one home per job" rule never quite lands (a job would be a workflow on
schedule but a queue job on demand).

**(b) On-demand also starts workflows** — recommended. The dispatch
functions call `start(<job>Workflow, [{ characterIds, taskId }])` instead
of `send()`; the per-character/per-corp workflows accept an optional
pre-enumerated target (skipping their enumerate step when given one, the
way `characterImplantsWorkflow` already threads `characterIds` through).
`refresh_task` tracking moves into the step: flip `running` before the
`run*()`, `done`/`error` after, preserving the consumer's exact
best-effort semantics (errors recorded and swallowed, terminal state
always reached). Then:

- The consumer's `JOBS` registry shrinks to nothing; the `jobs` queue
  topic, `src/app/api/queue/jobs/route.ts`, its `vercel.json`
  `experimentalTriggers` entry, and `src/utils/queue.ts` can all go
  **if** nothing else uses the queue by then (check the `innominate`
  topic — it's separate and stays).
- `/character/refresh`'s cells and the add-character flow behave
  identically from the user's side; only the engine underneath changes.

Do (b) as its own small PR stack: thread `characterIds`/`taskId` through
the workflows first (backward-compatible), then flip `dispatchRefresh.ts`,
then delete the consumer. Each step is revertable alone.

## 3. Retire the `character-implants` pilot

The pilot did its job. With the fan-out pattern landed:

- Delete the queue-consumer special case for `character-implants`.
- Delete the manual trigger route `/api/cron/character-implants` (it was
  explicitly "delete once the pilot is proven out") — or, if a standalone
  implants schedule is ever wanted, rebuild it as a normal phase-3-style
  workflow; today `character-status` covers implants on the schedule, so
  deletion is the default.
- `src/workflows/characterImplants.ts` goes with it (or is rewritten to
  the shared `lib.ts` shape if kept for manual/backfill use).

## 4. Documentation contract

- CLAUDE.md: rewrite the Extract jobs section — the four cron dispatch
  shapes are gone; describe the workflow trigger shape and the
  `src/workflows/` per-job convention instead. Update the sde-mirror
  bullet that calls its trigger "a fifth cron dispatch shape" (it's now
  *the* shape).
- Mark every row of this plan's README table done; note the end state at
  the top.
- If the [`/workflow` page](../workflow-jobs-page.md) has been built, its
  registry should now list every extract job and `/character/refresh`'s
  scope per that plan's move rule; if it hasn't, its "initial content"
  section needs updating to reflect that everything is a workflow now.

## Verification

- `pnpm run lint` && `pnpm run build`, as ever.
- After (b): run the full add-a-character flow and a single-cell refresh
  on `/character/refresh`; confirm `refresh_task` rows reach terminal
  states and the matrix updates live.
- Grep for `send('jobs'` and `fanOutPer` — both should be gone.
- Watch one full day of schedules (the 6h cycle plus the 09:xx dailies and
  12:21 sde-mirror) in Observability → Workflows with everything
  migrated.
