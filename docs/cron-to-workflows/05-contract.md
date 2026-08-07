# Phase 5: contract — retire the old scheduled plumbing, settle the queue's fate

> **✅ Done.** Shipped as three PRs: the pilot retirement (§3, first —
> its manual trigger route was the last caller of
> `fanOutPerCharacterCronJob`), then the on-demand migration + deletions
> (§1 + §2, as the three-commit stack sketched below), with the
> `heartbeat.ok`/`error` failure-visibility follow-up
> (docs/jobs-page.md's known gap) as its own third PR. Deviation from the
> plan as written: `runDirectCronJob` was **kept**, not deleted — the
> `esf-data` and `sheet-csv` manual bootstrap routes still run inline
> under it, which this doc predated.

After phases 1–4, every scheduled extract job `start()`s a workflow. This
phase deletes what that stranded and makes the one real remaining
decision: what happens to the on-demand "Refresh ESI" path.

## 1. Delete the dead cron helpers — ✅ done

In `src/utils/cron.ts`:

- ~~`dispatchAccountCronJob`~~ (phase 2 orphaned it)
- ~~`fanOutPerCharacterCronJob` / `fanOutPerCharacterAnyScopeCronJob`~~
  (phase 3; the `character-implants` manual trigger route was its last
  caller — deleted in §3)
- ~~`fanOutPerCorporationCronJob`~~ (phase 4)
- `runDirectCronJob` **stays** (not in the original list's reasoning):
  the unscheduled `esf-data` / `sheet-csv` manual bootstrap routes run
  inline under it, and that's the right shape for them.

`requireCronSecret` stays — every cron route still uses it.

## 2. The on-demand path — ✅ done, option (b)

`dispatchRefresh.ts` / `dispatchSingleJob` now `start()` the job's
workflow — the same workflow the cron routes start on the schedule —
passing an optional `{ registrationIds, taskId }` (`OnDemand` in
`src/workflows/lib.ts`). The per-character workflows skip their
enumerate step and sync just the given registrations; the per-corp
workflows treat the list as one corp's whole scoped-character group
(never split, so a corp's reconcile still can't race itself).
`refresh_task` tracking moved into the `markRefreshTask` step: `running`
before the work, `done`/`error` after, preserving the consumer's exact
best-effort semantics (a failed status write is logged and swallowed,
and a failed run still reaches a terminal state before the
`AggregateError` surfaces in Observability).

Deleted with the flip: `src/app/api/queue/jobs/route.ts`, its
`vercel.json` `experimentalTriggers` entry, and the three queue fan-out
helpers (§1). `src/utils/queue.ts` **stays** — the `innominate`
appraisal topic still uses it.

`/character/refresh`'s cells and the add-character flow behave
identically from the user's side; only the engine underneath changed.

It shipped as the three-commit stack this section recommended: thread
`registrationIds`/`taskId` through the workflows (backward-compatible),
flip `dispatchRefresh.ts`, then delete the consumer. Each commit is
revertable alone.

## 3. Retire the `character-implants` pilot — ✅ done

The pilot did its job; all three pieces are deleted (its own PR, ahead of
§1/§2 because the manual trigger route was the last caller of
`fanOutPerCharacterCronJob`):

- ~~the queue-consumer special case for `character-implants`~~
- ~~the manual trigger route `/api/cron/character-implants`~~
- ~~`src/workflows/characterImplants.ts`~~

The job module (`src/jobs/characterImplants.js`) stays: `character-status`
calls its `syncCharacterImplants` on the schedule, and it remains
CLI-runnable and in the queue consumer's `JOBS` registry until §2 deletes
the consumer.

## 4. Documentation contract — ✅ done

- CLAUDE.md's Extract jobs section describes the workflow trigger shape
  (every job `start()`s its workflow, on schedule and on demand alike);
  the queue-consumer and dispatch-shape descriptions are gone.
- The README notes the end state at the top.
- The [`/jobs` page](../jobs-page.md) is unblocked: its refresh path is
  now `dispatchSingleJob` → `start()`, and its "Status semantics"
  section's `refresh_task` transitions live in the `markRefreshTask`
  workflow step.

## Verification

- `pnpm run lint` && `pnpm run build`, as ever.
- After (b): run the full add-a-character flow and a single-cell refresh
  on `/character/refresh`; confirm `refresh_task` rows reach terminal
  states and the matrix updates live.
- Grep for `send('jobs'` and `fanOutPer` — both should be gone.
- Watch one full day of schedules (the 6h cycle plus the 09:xx dailies and
  12:21 sde-mirror) in Observability → Workflows with everything
  migrated.
