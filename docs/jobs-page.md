# Plan: the extract jobs page (`/jobs`)

One page that answers, for a signed-in user: **which extract jobs feed my
data, when did each last run, what is it doing right now, and when does it
run next.** It replaces `/character/refresh` outright — same URL redirected,
same refresh buttons, same `refresh_task` plumbing — and adds the two things
that page never had: the **next scheduled run**, and a durable view of the
runs the user has **enqueued** themselves.

> **Supersedes `docs/workflow-jobs-page.md`** (deleted with this plan). That
> plan described a `/workflow` page whose purpose was to be a _scoreboard for
> the cron → Workflows migration_: jobs moved onto it one at a time as they
> migrated, and the page's registry existed to declare which jobs had. That
> premise is gone — every scheduled job is a Vercel Workflow as of phase 4
> (#712), so a page that lists "the workflow jobs" would list all of them and
> `/character/refresh` would be left nearly empty. "Runs as a workflow" is now
> an implementation detail with no user-facing meaning, which is also why the
> page is named after jobs rather than after the engine.

## Prerequisite: finish the migration first — ✅ satisfied

Phase 5 of [`cron-to-workflows`](cron-to-workflows/05-contract.md) has
landed, settling every mechanic this page was waiting on:

- **On-demand refreshes start workflows** (§2 chose option b):
  `dispatchRefresh`/`dispatchSingleJob` `start()` the same workflow the cron
  routes start, and `refresh_task` transitions (`running` → `done`/`error`)
  live in the `markRefreshTask` step (`src/workflows/lib.ts`). The "Status
  semantics" section below describes exactly that end state.
- **The dead cron helpers are gone** — `refreshCell`'s allow-list still reads
  `PER_CHARACTER_JOBS` / `PER_CORPORATION_JOB_NAMES` / `ACCOUNT_JOBS` from
  `dispatchRefresh.ts`; this page's registry replaces that list when built.
- **The `character-implants` pilot is retired** — implants stays folded into
  `character-status`, so it is not a row on this page.

The page can now be built.

## Sections

Four, in this order. Every section is registry-driven (`src/app/jobs/registry.ts`),
so a job appears in exactly one of them.

### 1. Characters

One row per **job**, not per character — the job is what has a schedule. The
per-character detail is a nested expansion.

| Job                                  | Characters | Last run    | Status    | Next run  |
| ------------------------------------ | ---------- | ----------- | --------- | --------- |
| assets · `character-assets`          | 4          | 2 hours ago | idle      | in 3h 26m |
| industry · `character-industry-jobs` | 4          | 5 hours ago | ● running | in 1h 48m |

- **Last run** is the **oldest** of the caller's characters' last runs, not the
  newest. The question the row answers is "is my data fresh", and one
  character that hasn't pulled in a day is the answer even if the other three
  ran ten minutes ago.
- The **Characters** column notes `· 1 lagging` when some characters are a
  freshness grade behind the best-off one. Deliberately _not_ "0 of 4 fresh" —
  for a six-hourly job that's the normal state most of the day and teaches the
  reader to ignore the column. One character behind the others is the signal
  worth surfacing: it usually means a dead token or a missing scope.
- **Overdue is computed from the _newest_ run, not the oldest.** "Did the cron
  fire at all" and "is every character current" are different questions, and
  one lagging character must not make the schedule itself look broken.
- Expanding a row (`<details>`, server-rendered — no client JS needed to open
  it) reveals today's matrix column: one line per registration with its own
  freshness `Cell` and refresh button. Nothing about per-character refresh
  changes; it just stops being the page's top-level axis.

### 2. Corporations

Same job-row shape, plus the thing corp jobs need and character jobs don't:
**whose token did the pull**.

| Job                                    | Corporations | Runs as        | Last run    | Status | Next run   |
| -------------------------------------- | ------------ | -------------- | ----------- | ------ | ---------- |
| assets · `corp-assets`                 | 1            | Philihp Boeing | 9 hours ago | idle   | in 14h 27m |
| wallet journal · `corp-wallet-journal` | 2            | _(per corp)_   | 3 hours ago | idle   | in 2h 37m  |

- **Runs as** names the character whose director/accountant-role token the
  most recent successful pull actually ran under — read off the newest
  corp-scoped heartbeat's `character_id`, which `forEachCorporation`
  (`src/jobs/lib.js`) already attributes per run. Three cases, all of which
  today's `corpRunsAs` reduction in `src/app/character/refresh/page.tsx`
  already handles and which port over verbatim:
  1. the token belongs to one of the caller's registrations → name it;
  2. the heartbeat is corp-scoped but the character isn't one of ours → _"a
     corpmate's"_ (another account in the same corp has a director token; the
     corp heartbeat is visible under the corp RLS policy, the registration
     isn't);
  3. no corp heartbeat yet → name the representative character
     `dispatchSingleJob` would pick, so the column still says who _would_ run
     it.
- With more than one corporation the collapsed row shows _(per corp)_ and the
  expansion carries a **Runs as** per corporation. This matters more than it
  looks: "corp assets are stale" and "the only director token we had for that
  corp stopped working" are the same symptom, and naming the character is what
  distinguishes them.
- Expansion rows are per corporation, with the corp's own freshness `Cell`,
  refresh button, and `Runs as`.

### 3. Shared universe

The jobs that are nobody's in particular — whole-universe and account-wide
pulls whose heartbeats carry `user_id IS NULL` and are readable by every
signed-in user (the existing `heartbeat` RLS policy already exposes them).
This is the section the old plan called "Universal", widened to include the
account-wide jobs that today sit in the refresh page's "Account-wide" table.

| Job                                         | Last run       | Status | Next run   |
| ------------------------------------------- | -------------- | ------ | ---------- |
| SDE mirror · `sde-mirror`                   | 19 hours ago   | idle   | in 5h 12m  |
| structures · `universe-structures`          | 11 hours ago   | idle   | in 13h 20m |
| names · `universe-names`                    | 42 minutes ago | idle   | in 5h 16m  |
| character directory · `character-directory` | 7 hours ago    | idle   | in 17h 5m  |
| industry indexes · `industry-systems`       | 3 hours ago    | idle   | in 2h 10m  |

- No freshness **dot** in this section. `src/app/freshness.ts` grades green
  <15 min / yellow <6h / red beyond, which is tuned to the 6-hourly
  per-character cadence; a nightly job like `sde-mirror` or
  `universe-structures` would sit red ~23 hours a day and teach the user to
  ignore the color. Plain relative text plus the next-run countdown carries it
  — and the countdown is the honest health signal here anyway (a job whose
  _next_ run is in the past is a job that didn't fire).
- Refresh buttons: `character-directory` and `universe-names` keep theirs
  (they're in `ACCOUNT_JOBS` today and cheap). `industry-systems` keeps its
  Chancellor gate (`isChancellor` server-side, per today's `refreshCell`).
  `sde-mirror`, `universe-structures` get none — the `?force=1` /
  `CRON_SECRET` cron routes stay operator tools.
- Because these rows are shared, a run kicked by another account shows up
  here as `running` for everyone. That is correct and worth a line of UI copy.

### 4. Recent activity — the runs you enqueued

The literal answer to "show me the refresh jobs I've enqueued". Every
`refresh_task` row belonging to the caller from the last 24 hours, newest
first:

| Enqueued | Job              | For               | Status                    | Took |
| -------- | ---------------- | ----------------- | ------------------------- | ---- |
| 14:22    | character-assets | Philihp Boeing    | ✓ done                    | 8s   |
| 14:22    | corp-assets      | Boeing Industries | ✗ error — `403 Forbidden` | 2s   |
| 14:19    | universe-names   | —                 | ✓ done                    | 31s  |

`refresh_task` already carries everything this needs (`job`, `character_id`,
`character_name`, `status`, `started_at`, `ended_at`, `error`, `batch_id`) and
is RLS-scoped to the caller. Today the refresh page reads these rows only as a
10-minute overlay on the matrix and then forgets them, so a job that failed
while the user was away is currently invisible — this section is the only
place a failed on-demand run is ever seen. Group by `batch_id` so one "add a
character" fan-out reads as one event rather than seven rows.

## Where "next scheduled run" comes from

`vercel.json`'s `crons` array is the scheduler's actual source of truth, so
the page imports it directly rather than restating schedules in a registry
that would drift:

```ts
import vercel from '../../../vercel.json' // resolveJsonModule is already on
```

Each entry is `{ path: '/api/cron/<job>', schedule: '<5-field cron>' }`, so
the job name is the last path segment and the schedule maps 1:1. Two pure
modules, no I/O:

- **`src/app/jobs/schedule.ts`** — `parseCron(expr)`, `nextCronRun(expr,
from)` and `previousCronRun(expr, from)`. Vercel evaluates cron in **UTC**;
  so does this. Supports `*`, `*/n`, `a-b`, `a,b` and combinations, and the
  standard day-of-month/day-of-week OR rule; anything else (`@daily`, `MON`,
  `L`/`W`/`#`) returns null rather than guessing. Implemented as a day-stepping
  tail recursion (≤366 frames) rather than a minute-by-minute scan, per the
  house preference against `for`/`while` — see `scanForward`/`scanBackward`.
- **`src/app/jobs/registry.ts`** — the job catalog: label, section, whether
  it's kickable, and `cronFor(job)` reading the import above. A job with no
  `vercel.json` entry (`character-skills`, `character-implants`, `esf-data`,
  `sheet-csv`) renders **manual only** in the Next run column.

The countdown itself renders client-side from an absolute ISO timestamp the
server passes down, the way `Freshness` already formats "N minutes ago" — so
ticking the clock never re-renders the server component.

**A missed fire is a signal worth rendering.** `nextCronRun` never returns the
past, so "the cron didn't fire" — the exact failure mode that moved these jobs
off GitHub Actions — is detected the other way round: `isOverdue(job, lastRun)`
compares the _previous_ scheduled fire against the newest run we can see, with
a 30-minute grace for runtime and scheduling slop. When it trips, the Next run
column reads `overdue` instead of a countdown. Note the honest limit: for a
fan-out job the caller only sees their own entities' heartbeats, so this means
"my data missed its pull", not "the cron is down".

## Status semantics

Per row (and per entity inside an expansion), first match wins:

| Status      | Derived from                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `● running` | a `refresh_task` of the caller's in `running`, **or** an open heartbeat — `started_at` set, `ended_at` null, `ran_at` within the last hour — for that job + owner |
| `· queued`  | a `refresh_task` in `pending`                                                                                                                                     |
| `✗ failed`  | a `refresh_task` in `error` (with its message on hover)                                                                                                           |
| `idle`      | anything else; the freshness dot carries the rest                                                                                                                 |

The open-heartbeat clause is what makes **scheduled** runs visible as
`running` — today's page can only see on-demand ones, because
`latest_heartbeats()` returns completed rows only. Reading the open rows needs
no new RPC: a direct `heartbeat` select is already RLS-scoped correctly (own
characters, own corps, and the `user_id IS NULL` shared rows).

### Known gap: a failed _scheduled_ run looks identical to a successful one

`withHeartbeat` (`src/jobs/lib.js`) and `runJobWithHeartbeat`
(`src/workflows/lib.ts`) both close the heartbeat pair from a `finally`, so a
run that threw still writes `ended_at` and the table cannot tell the two
apart. Only `refresh_task` records failure, and only for on-demand runs. So
`✗ failed` in the table above is reachable from section 4's data but not from
a cron run — a nightly job that has failed every night for a week shows a
red-ish freshness dot and nothing more.

Two ways out, both deliberately **out of scope for the page PR** so it stays a
UI change:

1. **`heartbeat.ok boolean` / `heartbeat.error text`** — set from the same
   `finally` that already writes `ended_at`. A normal dual write (`schema.sql`
   - an incremental migration) and a two-line change in the two heartbeat
     wrappers. Makes "last run failed" a first-class cell on this page and would
     also improve the header indicator.
2. **Leave it to Vercel Observability → Workflows**, and have the page link
   there per job.

Recommend (1) as a small follow-up PR once the page exists and the gap is
visible. Note that a fan-out workflow's `AggregateError` (one bad character in
a lane) already fails the _run_ while every other character's heartbeat closes
normally — so per-entity `ok` is the meaningful granularity, not per-job.

### Known gap: fan-out jobs have no whole-job heartbeat

Per-character and per-corporation workflows record heartbeats _inside_
`forEachCharacter` / `forEachCorporation` — one row per entity, no whole-job
pair (only the single-step workflows use `runJobWithHeartbeat`). So "when did
`character-assets` last run" is not a stored fact; it is `max`/`min` over the
caller's own entities, which is exactly what sections 1–2 compute and display.
This is fine — arguably better, since the user's question is about _their_
data — but it does mean the number differs between two accounts looking at the
same job. No change proposed; documented so nobody "fixes" it into an
account-independent number that means less.

## Route and navigation

- New page at **`/jobs`**. "Workflow" is an implementation detail now, and
  "refresh" undersells a page that is mostly read.
- `/character/refresh` → `/jobs`, **permanent redirect** in
  `next.config.mjs`, alongside the existing `/characters/refresh` entry (which
  then chains — collapse it to point straight at `/jobs`).
- `src/app/character/refresh/` is deleted; `Cell`, `RefreshButton`,
  `RefreshPoller` and the heartbeat reductions move to `src/app/jobs/`. The
  header's "Refreshed N minutes ago" link retargets to `/jobs`.
- The poller stays as-is (2s while anything is pending/running, off
  otherwise). It is the only thing on the page that polls; countdowns are
  client-side arithmetic.

## Files

| File                                                       | Change                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/app/jobs/registry.ts`                                 | New — job catalog: label, section, kickable, `cronFor()` over the `vercel.json` import. **(stubbed)**         |
| `src/app/jobs/schedule.ts`                                 | New — pure `parseCron` / `nextCronRun`, UTC. **(stubbed, with tests)**                                        |
| `src/app/jobs/page.tsx`                                    | New — the four sections. **(stubbed against mock data)**                                                      |
| `src/app/jobs/jobs.module.css`                             | New — table/status/countdown styles, lifted from `refresh.module.css`. **(stubbed)**                          |
| `src/app/jobs/stubData.ts`                                 | Temporary — mock heartbeats/tasks so the layout renders before the queries exist. **Deleted by the real PR.** |
| `src/app/jobs/actions.ts`                                  | New — `refreshCell` moved, allow-list rebuilt from the registry.                                              |
| `src/app/jobs/cell.tsx`, `refreshButton.tsx`, `poller.tsx` | Moved from `src/app/character/refresh/`.                                                                      |
| `src/app/character/refresh/*`                              | Deleted.                                                                                                      |
| `next.config.mjs`                                          | `/character/refresh` → `/jobs` permanent; retarget `/characters/refresh`.                                     |
| `src/app/layout/header.tsx`                                | Refresh indicator links to `/jobs`.                                                                           |
| `test/schedule.test.ts`                                    | New — cron parsing/next-fire assertions. **(stubbed, passing)**                                               |

No schema migration. (The optional `heartbeat.ok` column above is a separate
follow-up PR.)

## What is already stubbed in this repo

The plan ships with a rendering stub so the layout can be argued about before
the queries are written:

- `schedule.ts` and its tests are **real and complete** — `pnpm test` covers
  every cron shape `vercel.json` uses plus the general syntax.
- `registry.ts` is **real** — it reads the actual `vercel.json`, so the Next
  run column shows true times today.
- `page.tsx` renders all four sections against `stubData.ts` (three fake
  characters, two fake corps, real job names). Every place a Supabase query
  belongs is marked `TODO(jobs-page)`.
- Nothing is linked from the header yet and `/character/refresh` is untouched,
  so the stub is reachable only by typing `/jobs`.

## Verification (no test runner for pages; gates are lint + build + manual)

- `pnpm run lint`, `pnpm run build`, `pnpm test`.
- `/jobs` signed in: character rows show the oldest-of-my-characters freshness
  and expand to the per-character matrix; corp rows name the director token;
  the shared section lists five jobs with plain relative times; activity lists
  the last 24h of the caller's `refresh_task` rows grouped by batch.
- Kick one character job: the cell goes `queued` → `running` → freshness, the
  poller settles, and a row appears in Recent activity that survives a reload
  ten minutes later (the thing today's overlay loses).
- Next-run column matches `vercel.json` — spot-check a `*/6` job and a daily
  one against the UTC clock, and confirm nothing renders in local time.
- A second account sees the same shared-universe rows and only its own
  characters, corps, and activity.

## Explicitly out of scope

- Vercel API / Observability integration — run and step drill-down stays in
  Vercel's dashboard. This page reads our own tables only.
- Any change to schedules, job logic, extract tables, or the workflows
  themselves.
- The `heartbeat.ok` / `heartbeat.error` provenance column (follow-up).
- Per-job history charts or duration trends. `heartbeat.duration` is stored
  and would make a nice sparkline; not in this PR.
