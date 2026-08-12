# The extract jobs page (`/jobs`)

> **Shipped.** The page renders live data and `/character/refresh` is gone
> (permanently redirected). What follows is the design as built; the sections
> below describe the page that exists, not one that is planned.

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

## Prerequisite: finish the migration first

> **Phase 5 has landed** — the decisions below are resolved: the on-demand
> path `start()`s the same per-job workflows the cron routes do (option (b);
> `refresh_task` transitions live in `withRefreshTask`, `src/workflows/lib.ts`),
> the queue-dispatch cron helpers and the `/api/queue/jobs` consumer are
> deleted (`runDirectCronJob` survives for the unscheduled `esf-data`/
> `sheet-csv` bootstrap routes), and the `character-implants` pilot is retired
> (no row of its own; implants stay folded into `character-status`). This page
> is unblocked.

**This page does not start until [`cron-to-workflows` phase 5](cron-to-workflows/05-contract.md)
has landed.** Not a soft ordering — phase 5 decides the exact mechanics this
page renders:

| Phase 5 decision                                                    | What this page depends on                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2: does the on-demand path keep the queue, or `start()` workflows? | Every refresh button on this page goes down that path. If on-demand becomes workflows, `refresh_task` terminal status moves into a workflow step (phase 5's gap-2 pattern), and the "Status" column's failure semantics change with it.         |
| §1: delete the dead cron helpers                                    | `refreshCell`'s allow-list (`src/app/character/refresh/actions.ts`) is built from `PER_CHARACTER_JOBS` / `PER_CORPORATION_JOB_NAMES` / `ACCOUNT_JOBS`. This page's registry replaces that list; doing it before phase 5 means writing it twice. |
| §3: retire the `character-implants` pilot                           | Decides whether `character-implants` is a row at all, or stays folded into `character-status`.                                                                                                                                                  |

Building the page first would mean shipping a UI whose refresh path is
rewritten underneath it a PR later. Phase 5 first, then this.

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
  freshness `Cell` and refresh button, plus a **refresh everyone** button above
  them that kicks the job for every character in one batch. Nothing about
  per-character refresh changes; it just stops being the page's top-level axis.

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
- Refresh buttons: **Chancellor-only, for every job in this section that has
  one at all.** `character-directory` and `universe-names` shipped as
  `kickable: 'always'` (they're cheap and were in `ACCOUNT_JOBS`), but cheap
  isn't the test — these pulls are game-wide, so one account's button spends
  everyone's rate limit and moves data nobody else asked to move. They now sit
  behind the same `isChancellor` gate `industry-systems` always had, re-checked
  server-side in `refreshCell`. `sde-mirror` and `universe-structures` still get
  none — the `?force=1` / `CRON_SECRET` cron routes stay operator tools.
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

### Closed gap: failed runs are now recorded on the heartbeat ✅

`withHeartbeat` (`src/jobs/lib.js`) and `runJobWithHeartbeat`
(`src/workflows/lib.ts`) used to close the heartbeat pair from a `finally`, so
a run that threw wrote the same end row as one that succeeded and only
`refresh_task` recorded failure — and only for on-demand runs. Both wrappers
now stamp the end row with **`heartbeat.ok`** (true/false) and **`error`**
(the message, truncated) — see the `20260807020000_heartbeat_ok_error`
migration. Null means "outcome unknown": still-open rows, rows predating the
column, and CLI runs through code paths that don't pass it.

So the page can render `✗ failed` for scheduled runs too: a cell whose newest
end row has `ok = false` shows the failure (and its message on hover) instead
of an undifferentiated stale dot. Per-entity granularity comes free — the
per-character/per-corp rows are written by `withHeartbeat` per entity, so one
character with a dead token shows failed while its neighbors show fresh,
which is exactly the "1 lagging" diagnosis made explicit.

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

| File                                                             | Change                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/jobs/registry.ts`                                       | Job catalog: label, section, kickable, `cronFor()` over the `vercel.json` import, plus `jobEntry()` — the allow-list `refreshCell` gates on. |
| `src/app/jobs/schedule.ts`                                       | Pure `parseCron` / `nextCronRun` / `previousCronRun`, UTC.                                                                                   |
| `src/app/jobs/rows.ts`                                           | Pure reductions: oldest/newest run, lagging count, status precedence, activity grouping, the abandoned-task rule.                            |
| `src/app/jobs/page.tsx`                                          | The four sections, over live queries.                                                                                                        |
| `src/app/jobs/jobs.module.css`                                   | Table/status/countdown styles, lifted from `refresh.module.css`.                                                                             |
| `src/app/jobs/actions.ts`                                        | `refreshCell`, allow-list rebuilt from the registry.                                                                                         |
| `src/app/jobs/refreshButton.tsx`, `poller.tsx`, `loading.tsx`    | Moved from `src/app/character/refresh/`.                                                                                                     |
| `src/app/character/refresh/*`                                    | Deleted.                                                                                                                                     |
| `next.config.mjs`                                                | `/character/refresh` → `/jobs` permanent; `/characters/refresh` retargeted straight at `/jobs`.                                              |
| `src/app/layout/header.tsx`, `src/app/page.tsx`, `fittingMatrix` | Refresh links point at `/jobs`; the character callback lands there after adding a character.                                                 |
| `test/schedule.test.ts`, `test/jobsRows.test.ts`                 | Cron parsing/next-fire assertions; the row reductions.                                                                                       |

One migration, `20260812000000_latest_heartbeats_outcome`: `latest_heartbeats()`
now returns `ok` and `error` alongside `ended_at`, which is what lets a cell
render `✗ failed` for a _scheduled_ run rather than an undifferentiated stale
dot. Adding OUT columns changes the return type, so the function is dropped and
recreated (as in #754); the only other caller reads `job`/`ended_at` and is
unaffected.

## What shipped beyond the plan

- **Abandoned tasks.** A `refresh_task` left `pending`/`running` for over an
  hour is rendered as `✗ abandoned` and excluded from the status overlay and
  from the poller's "anything active" test — otherwise a run that died before
  flipping its row terminal pins a cell on "running" and the 2s poller on
  forever. This is the backstop
  [`cron-to-workflows/06-burn-in.md` §2](cron-to-workflows/06-burn-in.md) asked
  for, placed here rather than in a sweeper job nobody reads. The rows are left
  in the table (they are the evidence), just labelled honestly.
- **`character-fittings`** is a row: the plan's table predated it being a
  scheduled per-character job.
- **Two windows over `refresh_task`, not one.** Recent activity reads 24 hours;
  the per-cell status overlay reads only the last 10 minutes, so an on-demand
  error from this morning doesn't outrank a scheduled pull that has since
  succeeded.

### Closed gap: a corp you don't direct is a no-op, not a failure ✅

The corp endpoints need an **in-game role** (director, accountant, station
manager) on top of the OAuth scope, and ESI answers a character without it with
`403 Character does not have required role(s)`. That threw, so the per-corp
heartbeat closed `ok = false` and the row read `✗ failed` every six hours — for
something that never was a failure. Nothing broke; the pilot was simply never
allowed to ask, and re-running earns the same 403.

That outcome is now its own thing, end to end:

- `src/esi.js` throws `EsiError` (status + body) instead of a bare `Error`, and
  `isRoleDenial(e)` recognises the role 403. Matched on the **body**, not on the
  bare status: a 403 also covers an expired or revoked token, which _is_ a
  failure and keeps surfacing as one.
- `forEachCorporation` (`src/jobs/lib.js`) closes that character's heartbeat
  `ok = true` with **`heartbeat.skipped_reason`** naming them, logs it as a skip
  rather than a FAILED, and still leaves the corp unclaimed so a corpmate with
  the role gets their turn in the same run. `withHeartbeat` takes a
  `skipReasonOf(e)` classifier for this; nothing else uses it yet.
- Migration `20260812120000_heartbeat_skipped_reason` adds the column and carries
  it through `latest_heartbeats()`.
- The page renders `— not a director` (the reason on hover), offers no refresh
  button for it, and — the part that matters beyond the label — **excludes
  skipped entities from `oldestRun` and `laggingCount`**, so a corp nobody on the
  account directs stops pinning its job's row at "never" forever. A row reads
  `skipped` only when _every_ entity is one; one unreachable corp doesn't relabel
  a job that ran fine for the other.

Known limit: the on-demand path still records `refresh_task` as `✓ done` for such
a run, since nothing threw. Recent activity has no column for "did nothing, on
purpose"; the cell carries that fact instead.

### Also shipped: two refresh-button changes

- **Shared universe kicks are Chancellor-only.** `universe-names` and
  `character-directory` were `kickable: 'always'`; both are now `'chancellor'`,
  like `industry-systems`. These pulls are game-wide — one account's button
  spends everyone's rate limit and moves data nobody else asked to move —
  so every kickable job in that section is now gated the same way, and
  `refreshCell` re-checks server-side.
- **"Refresh everyone" per character job.** The Characters expansion carries one
  button that kicks the job for every registered character (`refreshAllCharacters`
  → `dispatchJobForCharacters`), under a single `batch_id` so Recent activity
  reads it as the one action it was. Per-character jobs only: a corp job's unit
  of work is the corporation, and fanning one run per character is the
  concurrent-reconcile race `PER_CORPORATION_JOBS` exists to avoid.

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
