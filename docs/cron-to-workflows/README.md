# Cron → Vercel Workflows: migration plan

Move every scheduled extract job off the current Cron → (inline | queue)
execution paths and onto **Vercel Workflows**, in risk order: the simplest,
lowest-blast-radius jobs first, the complex reconcilers last. Each numbered
doc below is a self-contained implementation spec; do them as **separate
PRs, in order** (within a phase, jobs are listed in their own risk order).

## Why

Two workflow jobs already exist and prove the chain end to end:

- `character-implants` (`src/workflows/characterImplants.ts`) — the pilot;
  validated queue → `start()` → `'use step'` → job module unchanged.
- `sde-mirror` (`src/workflows/sdeMirror.ts`) — real multi-step
  orchestration: cursor-resumable slices, bounded parallel lanes,
  deterministic replay, tail steps that start on their actual inputs.

What Workflows buy over the current paths:

- **Own duration budget per step.** The queue consumer and the direct-run
  cron routes share one 60s invocation cap
  (`src/app/api/queue/jobs/route.ts` documents this as a live risk for the
  whole-corp jobs). A workflow step is its own function invocation; a job
  that outgrows 60s can later split into resumable steps (the `sde-mirror`
  slice pattern) without changing its schedule or callers.
- **Bounded retries with visibility.** The queue retries whole messages
  blindly (`retryAfterSeconds: 60`); a workflow retries the failed *step*,
  and every run/step's status, timing, and error shows under Vercel's
  Observability → Workflows.
- **Structural serialization.** The per-corporation jobs exist in their
  current one-message-per-corp shape *because* concurrent queue messages
  once raced the same corp's SCD-2 reconcile and corrupted it (see the long
  comment on `fanOutPerCorporationCronJob` in `src/utils/cron.ts`). A
  workflow expresses "one step per corp, never concurrent for the same
  corp" directly in control flow.
- **One fewer moving part** on the scheduled path once the queue hop is
  gone (phase 5; the on-demand "Refresh ESI" queue path is untouched until
  then).

## Current state (what runs how, today)

18 crons in `vercel.json`, all hitting `/api/cron/<job>` routes guarded by
`requireCronSecret`. Four dispatch shapes live in `src/utils/cron.ts`, plus
the workflow shape used by `sde-mirror`:

| Shape | Jobs | Execution today |
|---|---|---|
| `runDirectCronJob` (inline) | ~~`industry-systems`~~, ~~`universe-structures`~~, ~~`corp-structures`~~, ~~`corp-wallet-journal`~~, ~~`corp-blueprints`~~ (all migrated — `runDirectCronJob` now unused, deleted in phase 5) | Whole job inside the cron route's single 60s invocation |
| `dispatchAccountCronJob` (1 queue msg) | ~~`universe-names`~~, ~~`character-directory`~~ (migrated; was `character-affiliations`) | Queue consumer runs the batch, records the whole-job heartbeat |
| `fanOutPerCharacterCronJob` (1 msg/char) | `character-orders`, `character-assets`, `character-blueprints`, `character-mercenary-dens`, `character-wallet-transactions`, `character-industry-jobs` | Queue consumer runs per character |
| `fanOutPerCharacterAnyScopeCronJob` | `character-status` | Same, any-of-scopes token selection |
| `fanOutPerCorporationCronJob` (1 msg/corp) | `corp-assets`, `corp-industry-jobs`, `corp-wallet-transactions` | Queue consumer runs per corp |
| `start()` a workflow | `sde-mirror` | Already a workflow — **done, not in scope** |

Not in scope: `sde-mirror` (already migrated), `esf-data` (unscheduled
manual bootstrap; the scheduled encode is a tail step of `sde-mirror`),
`heartbeat` (stays on GitHub Actions on purpose — it's a canary for
scheduled-trigger health), and the individual `character-wallet`/
`-location`/`-clones`/`-implants`/`-ship` modules (unscheduled;
`character-status` covers them — though the `character-implants` pilot gets
retired in phase 5).

## Target architecture

Every `/api/cron/<job>` route keeps its path and schedule (`vercel.json`
does not change) but becomes a thin trigger, exactly like
`src/app/api/cron/sde-mirror/route.ts`:
`requireCronSecret` → `start(<job>Workflow, […])` → return `runId`.

One workflow file per job under `src/workflows/` (matching the one-file-
per-job convention in `src/jobs/`), each a thin named export so
Observability shows distinct workflow names. The heavy lifting stays in the
untouched `src/jobs/*.js` modules — every step lazy-imports them (their
top-level supabase/esi setup needs env vars absent at build time; both
existing workflows document this).

Three workflow shapes cover all 15 jobs:

1. **Single-step** (phases 1–2): one `'use step'` that records the
   start/end heartbeat (`source: 'vercel-workflow'`) around the job's
   `run*()`. Execution-equivalent to today, plus retries + observability.
2. **Per-character fan-out** (phase 3): step 1 enumerates scoped
   characters; then one step per character, spread across a small number of
   **statically assigned lanes** (the `sde-mirror` largest-first/
   round-robin pattern — static assignment keeps replay deterministic).
   Per-character heartbeats keep coming from `forEachCharacter` inside the
   step, unchanged.
3. **Per-corporation fan-out** (phase 4): step 1 groups characters by corp
   (`groupCharacterIdsByCorporation`); one step per corp, same lane
   pattern. Same-corp serialization is now structural, not a queue-shape
   convention.

The on-demand "Refresh ESI" path (`dispatchRefresh.ts` → queue →
`/api/queue/jobs`) is **deliberately untouched until phase 5** — every job's
`run*()` stays callable from CLI, queue, and workflow throughout, so each
migration PR only swaps the scheduled trigger.

## Risk model (what makes a job high-risk here)

- **Write pattern**: append-only insert < live-row upsert < SCD-2
  reconcile (a botched reconcile closes rows that never reopen — this has
  happened; see the corp race history).
- **Fan-out shape**: single batch < per-character < per-corporation (the
  corp jobs carry the race scar tissue and the in-game-role token
  fallback).
- **Volume/pagination**: single-request snapshots < paginated multi-page
  pulls (`character-assets`, `corp-assets`).
- **Moving parts changed by the migration**: phase 1 changes almost
  nothing (same single invocation, new wrapper); phase 3 replaces the
  queue on the scheduled path; phase 4 does that for the most fragile
  reconcilers.

## The plan

| Doc | Jobs (in-phase risk order) | Shape change | Status |
|---|---|---|---|
| [01-direct-jobs.md](01-direct-jobs.md) | `industry-systems` ✅, `universe-structures` ✅, `corp-structures` ✅, `corp-wallet-journal` ✅, `corp-blueprints` ✅ | inline → single-step workflow | ✅ **Done** — all 5 migrated; `runDirectCronJob` now unused (deleted in phase 5) |
| [02-account-jobs.md](02-account-jobs.md) | `universe-names` ✅, `character-directory` ✅ (was `character-affiliations`) | 1 queue msg → single-step workflow | ✅ **Done** |
| [03-per-character.md](03-per-character.md) | `character-wallet-transactions` ✅, `character-orders` ✅, `character-industry-jobs`, `character-status`, `character-mercenary-dens`, `character-blueprints`, `character-assets` | per-char queue fan-out → fan-out workflow | 🚧 In progress — `character-wallet-transactions`, `character-orders` migrated |
| [04-per-corporation.md](04-per-corporation.md) | `corp-wallet-transactions`, `corp-industry-jobs`, `corp-assets` | per-corp queue fan-out → fan-out workflow | — |
| [05-contract.md](05-contract.md) | — | retire dead cron helpers, decide the on-demand queue path, retire the `character-implants` pilot | — |

Phase 1's first PR migrates **one** job (`industry-systems`) to establish
the single-step pattern; the rest of the phase can then batch 2–3 jobs per
PR. Phase 3's first PR likewise migrates only `character-wallet-transactions`
to establish the fan-out pattern. Update the Status column (and CLAUDE.md's
Extract jobs section) as PRs land.

Related plan: [docs/workflow-jobs-page.md](../workflow-jobs-page.md)
(a `/workflow` dashboard page that grows as jobs migrate). If that page
exists by the time a job migrates, the migration PR adds the job to its
registry per that doc's rules; if not, nothing blocks on it.

## Verification (every PR)

No test runner exists. The gates are:

1. `pnpm run lint` and `pnpm run build` pass.
2. After deploy, trigger the cron route by hand:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/<job>`
   and confirm the run + steps go green under Observability → Workflows.
3. Confirm the heartbeat pair landed (`latest_heartbeats()` /
   `/character/refresh` for per-character jobs) and the job's table shows a
   fresh `valid_until` / `recorded_at` bump.
4. Watch the next *scheduled* firing before starting the next phase.

Rollback for any single PR is a plain revert: the routes go back to the
previous dispatch shape, and the job modules were never touched.

## House rules (from CLAUDE.md — these bite)

- **No test runner.** Lint + build + manual exercise, per above.
- **Ramda over `for`/`while`** in job code — but workflow *orchestrator*
  bodies are the documented exception (see the comment in
  `src/workflows/sdeMirror.ts`): plain, deterministic control flow over
  step calls, no helpers imported at workflow (non-step) level. Ramda
  itself *is* okay in a workflow body, though: its pure combinators
  (`map`, `reduce`, `transpose`, `splitEvery`, …) are referentially
  transparent — identical on every replay — and pull in no Node modules,
  so they don't trip the compiler's ban the way an impure/Node-touching
  helper would. `characterWalletTransactions.ts` uses
  `transpose(splitEvery(LANES, ids))` for the lane split and a `reduce`
  promise-chain for the sequential per-lane drain. The exception is only
  about *not importing workflow-level helpers that run impure/Node code in
  workflow context*, not about avoiding ramda.
- **Lazy-import job modules inside steps** — their top-level setup needs
  runtime env vars.
- **`git fetch origin && git rebase origin/main`** immediately before
  pushing every PR. No exceptions.
- Job names double as npm script, queue message name, heartbeat label, and
  now workflow file name — keep the convention.
- Pre-commit hooks auto-format; don't fight them.
- Line numbers cited in these docs will drift — anchor on the quoted code.
