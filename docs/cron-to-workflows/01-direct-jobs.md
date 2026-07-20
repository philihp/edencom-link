# Phase 1: the direct-run jobs → single-step workflows

The five jobs whose cron routes run them **inline** via `runDirectCronJob`
(`src/utils/cron.ts`): `industry-systems`, `universe-structures`,
`corp-structures`, `corp-wallet-journal`, `corp-blueprints`.

## Why these are lowest risk — and highest immediate payoff

- Execution semantics barely change: today the whole job runs in one cron
  invocation; after migration it runs in one workflow step. Same single
  process, same job code, same heartbeat pair. The only new behavior is
  Workflows' bounded step retries and the Observability trail.
- They are also the only jobs still exposed to the **60s function cap**
  (called out as a real risk in `src/app/api/queue/jobs/route.ts` — "watch
  these jobs' heartbeat durations"). Migrating them first doesn't remove
  the cap (a single step still has a duration budget), but it puts them in
  the one execution model where the fix — splitting into resumable slices
  like `sde-mirror`'s `ingestSlice` — is a local change instead of a
  re-architecture.
- No queue involvement today, so nothing about fan-out or message shapes
  changes. `vercel.json` is untouched (same paths, same schedules).

## In-phase order (simplest write pattern first)

| # | Job | Runs | Write pattern | Notes |
|---|---|---|---|---|
| 1 | `industry-systems` | every 6h `:10` | append-only insert (`industry_system_index`) | Public ESI endpoint, no tokens at all. **First PR: this job alone**, to establish the pattern. |
| 2 | `universe-structures` | 09:57 daily | upsert cache (`universe_structure`) | Token-authed reads, but a plain refresh of already-known ids. |
| 3 | `corp-structures` | 09:17 daily | upsert (`corp_structure`) + name resolution | Per-corp token loop via `forEachCorporation` (which records its own per-corp heartbeats — see below). |
| 4 | `corp-wallet-journal` | every 6h `:37` | paged append (`corp_wallet_journal`) + name resolution | Append-only; re-running a partially-failed pull is naturally idempotent (PK on entry id). |
| 5 | `corp-blueprints` | 09:07 daily | **SCD-2 reconcile** (`corp_blueprint_over_time`) | The one reconciler in this phase — do it last, after the pattern has survived a few scheduled firings. |

Jobs 2–5 can batch two per PR once #1 has landed and fired on schedule.

## Step 1 — a shared single-step helper

Add `src/workflows/lib.ts` with the workflow-side equivalent of
`runDirectCronJob` (same start/end heartbeat contract, workflow source):

```ts
// src/workflows/lib.ts
// Single-step execution of a whole extract job, with the same start/end
// heartbeat pair runDirectCronJob records — but source: 'vercel-workflow',
// and the step gets Workflows' bounded retries. Job modules are imported
// lazily by the caller-supplied loader: their top-level supabase/esi setup
// needs env vars absent at build time.
export async function runJobStep(job: string, load: () => Promise<() => Promise<unknown>>) {
  'use step'
  const { randomInt } = await import('node:crypto')
  const { recordHeartbeat } = await import('@/supabase.js')
  const run = await load()
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat(job, 'start', { runId, source: 'vercel-workflow' })
  try {
    await run()
  } finally {
    await recordHeartbeat(job, 'end', { runId, source: 'vercel-workflow' })
  }
}
```

Notes:

- A `'use step'` function may live in a shared module — but **verify this
  compiles under the `workflow` package's build in the first PR** (the
  directive compiler must pick it up outside the workflow's own file). If
  it doesn't, inline the step into each workflow file; the boilerplate is
  small and the pilot files already look like that.
- Retry caveat: if the *end* heartbeat write itself fails after the job
  succeeded, a step retry re-runs the whole job. Every job in this phase is
  idempotent (upserts / keyed appends / SCD-2 reconcile that converges), so
  this is safe — but it's why non-idempotent work must never share a step
  with its heartbeat bookkeeping.

## Step 2 — one workflow file per job

Thin, named per job so Observability → Workflows shows which is which
(mirror `src/workflows/characterImplants.ts`):

```ts
// src/workflows/industrySystems.ts
import { runJobStep } from './lib'

export async function industrySystemsWorkflow() {
  'use workflow'
  await runJobStep('industry-systems', async () => (await import('@/jobs/industrySystems.js')).runIndustrySystems)
}
```

Same file shape for `universeStructures.ts`, `corpStructures.ts`,
`corpWalletJournal.ts`, `corpBlueprints.ts`, each loading its
`run*()` export.

**Heartbeat subtlety for the corp jobs (#3–#5):** their `run*()` functions
use `forEachCorporation`, which records its own per-corp heartbeat rows.
`runDirectCronJob` *additionally* records a whole-job pair today, and
`runJobStep` preserves exactly that — so the heartbeat picture is
unchanged. Don't "simplify" the whole-job pair away; `/character/refresh`
and the daily freshness checks key off it.

## Step 3 — flip each cron route to `start()`

Replace the `runDirectCronJob` body with the `sde-mirror` trigger shape:

```ts
// src/app/api/cron/industry-systems/route.ts
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const { start } = await import('workflow/api')
  const { industrySystemsWorkflow } = await import('@/workflows/industrySystems')
  const run = await start(industrySystemsWorkflow, [])
  console.log(`[cron/industry-systems] started workflow run=${run.runId}`)

  return NextResponse.json({ ok: true, runId: run.runId })
}
```

Fire-and-forget: the route returns immediately; the workflow owns retries.
Keep `maxDuration = 60` on the route (it's just a trigger now, but there's
no reason to churn it).

## Step 4 — leave `runDirectCronJob` in place until phase 5

Other routes still use it while this phase is in flight. The contract doc
(05) deletes it once nothing references it.

## Verification (per PR)

1. `pnpm run lint` && `pnpm run build`.
2. Curl the route with `$CRON_SECRET`; confirm `{ ok, runId }`, then the
   run + step green in Observability → Workflows.
3. Confirm the whole-job heartbeat pair (and, for the corp jobs, the
   per-corp rows) via `latest_heartbeats()`; confirm the target table's
   freshness bump (`industry_system_index.recorded_at`,
   `corp_structure.fuel_expires` refresh, journal max `date`, blueprint
   `valid_until` bumps).
4. Watch the next scheduled firing before starting the next PR of the
   phase; for `corp-blueprints`, also spot-check the `corp_blueprint` view
   row count against the previous day (a reconcile bug shows up as items
   vanishing).

Each PR updates the job's row in CLAUDE.md's Extract jobs section (and the
README table here) to note it runs as a workflow.
