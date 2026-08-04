# Phase 5: contract — retire the old scheduled plumbing, settle the queue's fate

> **✅ Done.** §2 went the recommended way, (b): `dispatchRefresh`/
> `dispatchSingleJob` `start()` the per-job workflows with an `OnDemandTarget`
> (`src/workflows/lib.ts`), `refresh_task` tracking moved into the step
> (`withRefreshTask`), and the `jobs` queue topic, its consumer, and the four
> queue-dispatch helpers are deleted. §3 done: the `character-implants` pilot
> (workflow, consumer special case, manual trigger route) is deleted. One
> deviation from §1: `runDirectCronJob` stays — at implementation time the
> unscheduled `esf-data`/`sheet-csv` bootstrap routes still called it, which
> this doc's "nothing references these anymore" predates.

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
its 60s cap live forever, and the [`/jobs` page plan](../jobs-page.md)'s
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
- The [`/jobs` page](../jobs-page.md) is sequenced after this phase and
  reads whatever on-demand path §2 settles on, so nothing here blocks on
  it. Once §2 lands, re-read that plan's "Status semantics" section — it
  describes `refresh_task` transitions that (b) would move into a workflow
  step.

## Verification

- `pnpm run lint` && `pnpm run build`, as ever.
- After (b): run the full add-a-character flow and a single-cell refresh
  on `/character/refresh`; confirm `refresh_task` rows reach terminal
  states and the matrix updates live.
- Grep for `send('jobs'` and `fanOutPer` — both should be gone.
- Watch one full day of schedules (the 6h cycle plus the 09:xx dailies and
  12:21 sde-mirror) in Observability → Workflows with everything
  migrated.
