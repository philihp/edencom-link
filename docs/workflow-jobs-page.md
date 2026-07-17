# Plan: Vercel Workflow jobs page

A page focused **only on jobs that execute as Vercel Workflows** — the
dashboard for the incremental migration of the extract system onto the
`workflow` package. Jobs appear here as they migrate; the existing
`/character/refresh` matrix keeps covering everything that still runs inline
via Cron + Queue. Three sections, in this order:

1. **Universal** — read-only. Whole-universe/account workflow jobs; just the
   last time each ran. No buttons.
2. **Corp** — one row per corporation with columns for the corp workflow jobs
   (**wallet**, **structures**, **industry** once migrated), each a freshness
   cell + refresh button, plus a **Token** column naming the character whose
   director-role token the last pull ran under.
3. **Character** — a per-character × per-job freshness matrix like the current
   refresh page, restricted to migrated per-character jobs.

**Data source: heartbeats only.** Freshness comes from `latest_heartbeats()`
exactly like today's refresh page. No Vercel API integration — workflow
run/step detail stays in Vercel's own Observability → Workflows dashboard;
this page answers "when did we last hear from it, and can I kick it," which
the `heartbeat` table already answers with the caller's own RLS-scoped
permissions.

## What runs as a Workflow today (the page's initial content)

| Job | Section | Workflow | Scheduled? | Heartbeat owner |
|---|---|---|---|---|
| `sde-mirror` | Universal | `src/workflows/sdeMirror.ts` | 12:21 UTC daily (cron route `start()`s it) | `user_id IS NULL` — readable by any authenticated user |
| `character-implants` | Character | `src/workflows/characterImplants.ts` | No (pilot; manual trigger route only — `character-status` covers implants on the schedule) | per-character (`character_id` + `user_id` via `forEachCharacter`) |

So at launch: Universal shows one row, Character shows one column, and Corp
renders an empty-state note ("no corp jobs run as workflows yet"). That's
correct, not a bug — the page is the migration's scoreboard and grows with it.

## The registry: which jobs are "workflow jobs"

The `heartbeat` table records **no marker of how a run executed** —
`recordHeartbeat` (`src/supabase.js`) doesn't persist a source column (the
`source` opt mentioned in comments never lands in the row), and per-character
heartbeats written from inside a workflow step (`forEachCharacter` →
`withHeartbeat` in `src/jobs/lib.js`) are indistinguishable from queue-run
ones. So membership can't be inferred from data; it's declared in code:

```ts
// src/app/jobs/registry.ts (new)
export const WORKFLOW_JOBS = [
  { job: 'sde-mirror',          section: 'universal', label: 'SDE mirror' },
  { job: 'character-implants',  section: 'character', label: 'implants' },
  // ── added as each job migrates ──
  // { job: 'corp-wallet-journal', section: 'corp', label: 'wallet' },
  // { job: 'corp-structures',     section: 'corp', label: 'structures' },
  // { job: 'corp-industry-jobs',  section: 'corp', label: 'industry' },
] as const
```

Migrating a job = writing its `src/workflows/*.ts` + consumer/cron wiring
**and adding one registry line**. The page renders whatever the registry
holds; a section with no entries renders its empty-state note (or a row/column
appears the moment the entry lands). This keeps the page honest — it never
shows a job as "workflow-run" that isn't.

Also recommended (small, optional): give `recordHeartbeat` a persisted
`source` text column (`vercel-workflow` / `vercel` / `github`) so run
provenance is at least queryable later. Not needed for this page; the registry
stays the UI's source of truth either way. If taken, it's a normal dual write:
`schema.sql` + an incremental migration.

## Section-by-section

All three sections reuse the current refresh page's machinery
(`src/app/character/refresh/page.tsx`): the `latest_heartbeats()` read and its
`charBeats`/`corpBeats`/`accountBeats`/`corpRunsAs` reduction, `Cell`,
`Freshness`, `RefreshButton`, `RefreshPoller`, and the `refresh_task` overlay.
Filter each to registry membership.

### 1. Universal (read-only)

Two columns — **Job**, **Last run** — one row per `section: 'universal'`
registry entry. `sde-mirror`'s heartbeat pair is opened by the workflow's
first step and closed by finalize (`planRun`/`finalize` in
`src/workflows/sdeMirror.ts`), with `user_id IS NULL`, which the heartbeat RLS
policy (`user_id is null OR …`) exposes to every authenticated user — so this
section needs no new access plumbing.

No refresh button, per the requirement. (The existing `?force=1` /
CRON_SECRET-protected manual kick on the cron route is an operator tool and
stays out of the UI.)

> **Freshness coloring:** `src/app/freshness.ts` grades green <15 min / yellow
> <75 min / red beyond — tuned for 6-hourly extracts. A nightly job like
> `sde-mirror` would sit red ~23 hours a day. Universal rows should render the
> relative "N hours ago" text **without** the color dot (a `plain` prop on
> `Freshness`, reusing its formatter). A registry `cadence` field can later
> drive per-job thresholds if we want color back.

### 2. Corp (freshness + Token, refreshable) — lands with the corp migrations

Target state, activated as corp jobs migrate (see migration order below): one
row per corporation the user has a registered character in, columns:

| Corporation | Token | wallet | structures | industry |
|---|---|---|---|---|

- **Token** — whose director-role token the newest corp heartbeat ran under.
  Every corp job goes through `forEachCorporation` (`src/jobs/lib.js`), which
  attributes `corporation_id` + `character_id` + `user_id` per run — that
  attribution is unchanged when the same `run*()` function executes inside a
  workflow step, so the existing `corpRunsAs` logic (own character's name, a
  `"a corpmate's"` note, or the registration-order representative) copies over
  verbatim.
- **wallet / structures / industry** — `corp-wallet-journal`,
  `corp-structures`, `corp-industry-jobs`. Freshness `Cell` +
  per-cell refresh button + `refresh_task` overlay, exactly like the current
  corp table. ("Wallet" = the journal — the director-token wallet log — not
  `corp-wallet-transactions`, the market-trade feed already shown elsewhere.)
- Columns render only for migrated jobs (registry-driven), so the section can
  appear with just `wallet` and grow.

### 3. Character (matrix, refreshable)

Same table shape as today's refresh matrix — one row per registration, one
column per `section: 'character'` registry entry, `Cell` with freshness +
refresh button + task overlay. Per-character heartbeats written from workflow
steps carry `character_id`/`user_id` as before, so `charBeats` works
unchanged.

At launch the only column is `implants` (the pilot). Note in the UI copy that
implants also refreshes via `character-status` on the schedule — this page
shows the *workflow-run* extract specifically.

## Kicking a job from this page (on-demand refresh)

Reuse the queue path end-to-end — the consumer already special-cases workflow
jobs (`src/app/api/queue/jobs/route.ts` `start()`s `characterImplantsWorkflow`
for `character-implants` messages). A refresh button here goes: server action
→ `dispatchSingleJob` (`refresh_task` row + queue message) → consumer →
`start(<job>Workflow)`. Two gaps to close:

1. **`refreshCell` allow-list** (`src/app/character/refresh/actions.ts`):
   accepts only `PER_CHARACTER_JOBS` / `PER_CORPORATION_JOB_NAMES` /
   `ACCOUNT_JOBS`. Add the registry's kickable jobs (everything except
   `section: 'universal'`) to the check — or give this page its own thin
   server action doing the same auth + `dispatchSingleJob`, gated on registry
   membership. Corp-scoped workflow jobs keep the one-message-per-corp
   grouping (`dispatchSingleJob` already does this for anything in the corp
   job list — extend that list as corp jobs migrate, and keep the split
   between *on-demand* corp jobs and the *add-time* fan-out list so adding a
   character doesn't start kicking whole-corp pulls).
2. **`refresh_task` terminal status.** The consumer's workflow branch is
   fire-and-forget — it `start()`s the run and returns, so a `taskId` would
   sit `pending` forever (the pilot dodges this by never being dispatched with
   one). Fix: pass `taskId` through as a workflow argument; the consumer flips
   the row `running` before `start()`, and the workflow's final step marks it
   `done` (a failure that exhausts Workflows' bounded retries never marks
   `error` — accepted: the page's existing 10-minute task floor already
   un-pins cells whose terminal update was lost, so a dead run degrades to
   "stale cell with a refresh button," not a stuck spinner). This pattern goes
   into the migration template below.

## Migration order (how the page fills in)

Each migration is its own PR: `src/workflows/<job>.ts` + consumer/cron wiring
+ one registry line. Template = the two existing workflows: single-step jobs
copy `characterImplants.ts` (one `'use step'` calling the untouched `run*()`),
multi-step jobs copy `sdeMirror.ts` (cursor-resumable slices). Suggested
order, by payoff:

1. **`corp-wallet-journal`** — the job the codebase already flags as the 60s
   duration risk (per-division, sequential). Steps-per-division gives each
   division its own budget. First corp column (`wallet`) appears.
2. **`corp-structures`**, then **`corp-industry-jobs`** — completes the corp
   section as requested (structures is small; industry benefits from paging
   steps).
3. **Per-character extracts** (`character-assets` first — paged, largest) —
   the Character matrix grows past the pilot column one job at a time.
4. `character-status` last — it's the fan-out cost optimization; folding five
   pulls into a multi-step workflow needs its own design pass.

This plan's page PR doesn't block on any of these — it ships with the
registry at today's two entries, and each migration PR adds its line.

## Files touched (page PR)

| File | Change |
|---|---|
| `src/app/jobs/registry.ts` | New — `WORKFLOW_JOBS` registry. |
| `src/app/jobs/page.tsx` | New page: three registry-driven sections, reusing the refresh page's `Cell`/`Freshness`/`RefreshButton`/`RefreshPoller`/reductions (lift the shared pieces out of `src/app/character/refresh/` rather than duplicating). |
| `src/app/jobs/actions.ts` | Kick action: auth + registry-membership check + `dispatchSingleJob`. |
| `src/app/character/refresh/*` | Extract the shared `Cell`/reduction helpers for reuse; page behavior unchanged. |
| `src/app/api/queue/jobs/route.ts` | Generalize the workflow branch: a job-name → workflow map (today one entry) + the `taskId`-through-workflow pattern from gap 2. |
| `src/app/layout/header.tsx` | Optional: link to `/jobs` next to the existing refresh link. |

No schema migration required (unless the optional heartbeat `source` column is
taken). The existing `/character/refresh` page is untouched by the page PR;
whether a migrated job's column is *removed* from it (so each job has one
home) is decided per migration PR — recommended yes, to avoid double-listing.

## Open decisions

1. **Route.** New page at `/jobs` (recommended — workflows-only scope
   coexists with `/character/refresh` during the migration) vs. rebuilding
   the refresh page in place. Plan assumes `/jobs`.
2. **Empty corp section.** Render the empty-state note (recommended — shows
   the target shape) vs. hiding the section until a corp job migrates.
3. **Heartbeat `source` column.** Take the optional provenance column now, or
   skip until something needs it (registry suffices for the UI).
4. **De-listing migrated jobs from `/character/refresh`.** Recommended per
   migration PR; keep or change per job.

## Verification (no test runner; gates are lint + build + manual)

- `pnpm run lint`, `pnpm run build`.
- Manually: `/jobs` signed in — Universal shows `sde-mirror`'s last nightly
  run as plain relative text (no dot, no button); Character shows the
  `implants` column with per-character freshness; Corp shows the empty-state
  note. Kick `implants` for one character: `refresh_task` goes pending →
  running → done as the workflow completes (gap 2 wiring), the poller settles,
  and the run appears under Vercel Observability → Workflows.
- Confirm a signed-out visit redirects to login, and a second account sees the
  same `sde-mirror` row (the `user_id IS NULL` heartbeat) but only its own
  characters.

## Explicitly out of scope

- Vercel API / Observability integration (run/step drill-down stays in
  Vercel's dashboard).
- The job migrations themselves (each is its own PR per the order above; this
  page PR ships with today's two workflows).
- Any change to schedules, job logic, or the extract tables.
- Jobs that stay on Cron + Queue — they remain on `/character/refresh`.
