# Phase 6: burn-in and aftercare — prove it in production, close what phase 5 exposed

Phase 5 landed (#798) and the migration's structural goals are met: every
extract job — scheduled and on-demand — has exactly one execution engine, the
queue hop is gone from both paths, and per-corp serialization is control flow.
What this phase covers is the difference between *landed* and *done*: the
production verification phase 5 explicitly owed, plus four pieces of debt the
audit found that the earlier phases either created or deliberately deferred.

None of this blocks other work. §1 is observation, not code; §§2–4 are small
independent PRs in any order. The [`/jobs` page](../jobs-page.md) remains the
next real project and §3 directly feeds it.

## 1. Production burn-in (the verification phase 5 owed)

Phase 5 merged minutes before the day's last cron cycle, so at merge time the
new on-demand engine had never run in production. Checked so far: the
scheduled path ran two full cycles green on the phase 1–4 code the same day
(every job logging `started workflow run=…`, no error-level logs), and the
phase-5 deploy is serving. Still owed, in order of signal value:

- **One full scheduled day on the phase-5 deploy** — the 6h cycle (`:10`
  through `:58`), the 09:xx dailies, 11:41 `character-directory`, 12:21
  `sde-mirror` — all green under Observability → Workflows. This validates
  that deleting the queue consumer and the `vercel.json` `jobs` trigger
  changed nothing scheduled.
- **The add-a-character flow.** This is the first production exercise of
  `dispatchRefresh` → `start()`: ~13 workflow runs started from one server
  action (8 per-character + up to 3 corp + 2 account-wide). Confirm every
  `refresh_task` row reaches `done`/`error`, the `/character/refresh` matrix
  updates live, and the action itself stays acceptably fast — each `start()`
  is an API call where `send()` was, and if the serial cost shows, the fix is
  batching the starts, not reverting the engine.
- **One single-cell refresh** (`dispatchSingleJob`), including one corp-scoped
  cell — the target must carry the whole corp group, visible in the
  `[dispatchSingleJob] started …` log line.
- **One Chancellor `industry-systems` kick**, the only on-demand job outside
  `dispatchRefresh`'s own lists.

If any of these fail, the failure is in the new dispatch layer, not the job
modules — nothing inside `src/jobs/` changed in phase 5.

## 2. Sweep the queue-cutover orphans; decide the backstop

Deleting the consumer had one unavoidable data edge: any `jobs`-topic message
still undelivered at the phase-5 deploy died with its consumer, and a tracked
message's `refresh_task` row is stuck in `pending` forever — nothing will ever
flip it. The same terminal-less state remains reachable today in two thinner
ways: `start()` throws after the batch's rows are inserted, or a workflow run
exhausts its retries before its step ever reaches `withRefreshTask`'s
`running` flip.

- **One-time sweep** (data-only, not a migration — run against production
  once):

  ```sql
  update refresh_task
     set status = 'error',
         ended_at = now(),
         updated_at = now(),
         error = 'abandoned: jobs queue retired (cron-to-workflows phase 5)'
   where status in ('pending', 'running')
     and created_at < '<phase-5 production deploy timestamp>';
  ```

- **Backstop for the thin cases**: `/character/refresh` already floors its
  task overlay to the last few minutes, so stuck rows are invisible there —
  this is a data-hygiene question, not a UI bug. Recommendation: fold the
  backstop into the `/jobs` page implementation (its "Recent activity"
  section is the one place old rows become visible again; marking
  `pending`/`running` rows older than a day as abandoned belongs to whatever
  query renders them). Adding a sweeper to an extract job just to tidy rows
  nobody reads is not worth a moving part.

## 3. Record failure on the heartbeat pair

The migration promised "bounded retries **with visibility**" — delivered in
Vercel's Observability, but not in the project's own data layer.
`withHeartbeat` (`src/jobs/lib.js`) and `runJobWithHeartbeat`
(`src/workflows/lib.ts`) both close the heartbeat pair from a `finally`, so a
run that threw still records a clean-looking `ended_at`, and
`latest_heartbeats()` cannot distinguish a week of nightly failures from a
week of green — [`jobs-page.md`](../jobs-page.md) documents this as its known
gap, showing only "a red-ish freshness dot and nothing more."

Close it at the source:

- `heartbeat` gains an `error text` column (`schema.sql` **and** an
  incremental migration, per house rules).
- Both wrappers catch, stamp `error` on the `end` row, and rethrow —
  `recordHeartbeat` grows an `opts.error`. The `finally`-shaped guarantee
  (end row always written) is unchanged; only what the end row says changes.
- `latest_heartbeats()` exposes the column, so `/character/refresh` today and
  `/jobs` later can render a failed run as failed.

Small, self-contained, and the single highest-value item here: it turns the
freshness matrix from "when did it last run" into "did it last *work*."

## 4. Retire `runDirectCronJob` — the last non-workflow execution path

Phase 5 found the plan doc wrong about `runDirectCronJob` being dead: the
unscheduled `esf-data` and `sheet-csv` bootstrap routes (added after the doc
was written) still run their encodes inline through it. That leaves the
codebase with two execution shapes again, which is exactly what this project
existed to end.

Migrate both to the phase-1 single-step workflow shape (`esfDataWorkflow`,
`sheetCsvWorkflow` — one `'use step'` wrapping `runJobWithHeartbeat` around
the `?force=1`-aware encode), keep the routes' `CRON_SECRET` guard and
querystring behavior identical, then delete `runDirectCronJob` and the
`source: 'vercel-cron'` heartbeat value with it. Both encodes are idempotent
upserts, so a retried step converges — the shape fits without adaptation.
Alternative considered and rejected: blessing the helper as a permanent
exception; two manual routes don't justify a second engine.

## 5. Done in the phase-6 docs PR itself

- `01-direct-jobs.md` and `04-per-corporation.md` were missing the ✅ Done
  banners `02`/`03` carry — added.
- README table gains this phase's row.

## Verification

- §1 is itself the verification; record findings here when done.
- §2: the sweep's `update … returning id` count, and zero
  `pending`/`running` rows older than a day afterward.
- §3/§4: `pnpm run lint` && `pnpm run build`; for §3 confirm a deliberately
  failing CLI run (bad env) stamps `error` on its end row; for §4 curl both
  routes with `CRON_SECRET` and confirm the runs go green under
  Observability → Workflows and `grep -r runDirectCronJob src/` is empty.
