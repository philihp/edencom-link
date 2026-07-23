# Phase 3: the per-character jobs → fan-out workflows

The seven scheduled per-character jobs, whose cron routes today fan out one
queue message per scoped character (`fanOutPerCharacterCronJob`, or the
any-scope variant for `character-status`). After this phase, each cron
route `start()`s a workflow that enumerates the characters itself and runs
**one step per character**.

## Why third

This is the first real orchestration change: the queue leaves the
scheduled path for jobs with per-character tokens, ESI paging, and (for
most) SCD-2 reconciles. Everything per-character stays inside the
untouched job modules — token refresh, per-character heartbeats,
reconciles all live in `forEachCharacter` and the `run*()` functions — so
the workflow only replaces the *dispatch* layer. Still, the fan-out
pattern (lanes, determinism, retry blast radius) needs proving on the
safest job before the reconcilers follow.

## In-phase order

| # | Job | Write pattern | Why this slot |
|---|---|---|---|
| 1 | `character-wallet-transactions` | append-only + ETag skip | Safest possible: single-request snapshot, keyed append, a `304` makes most steps near-no-ops. **First PR: this job alone**, establishing the fan-out pattern. |
| 2 | `character-orders` | SCD-2 + ETag, single request | Small data, ETag-guarded. |
| 3 | `character-industry-jobs` | SCD-2 + ETag, single request | Same shape as orders. |
| 4 | `character-status` | live-row upserts ×5 endpoints | No SCD-2 except clones; internally fault-isolated per endpoint already. Uses the **any-scope** enumeration (see below). |
| 5 | `character-mercenary-dens` | SCD-2 + append-only status + per-den detail calls | Extra ESI call per den; niche data. |
| 6 | `character-blueprints` | SCD-2, paginated | First paginated reconciler. |
| 7 | `character-assets` | SCD-2, paginated + asset names | Biggest volume and the most user-visible table — last. |

## The fan-out workflow shape

```ts
// src/workflows/lib.ts (additions)

// Step: enumerate the registration uuids carrying the job's scope(s).
export async function enumerateCharacters(scopes: string[]): Promise<string[]> {
  'use step'
  const { selectCharacterIdsWithScopes } = await import('@/supabase.js')
  return selectCharacterIdsWithScopes(scopes)
}

// Step: run one job for one character. forEachCharacter (src/jobs/lib.js)
// still does token refresh + the per-character heartbeat pair, unchanged.
export async function runCharacterStep(
  job: string,
  load: () => Promise<(opts: { characterIds: string[] }) => Promise<unknown>>,
  characterId: string
) {
  'use step'
  const run = await load()
  await run({ characterIds: [characterId] })
}
```

```ts
// src/workflows/characterWalletTransactions.ts
import { enumerateCharacters, runCharacterStep } from './lib'

const load = async () =>
  (await import('@/jobs/characterWalletTransactions.js')).runCharacterWalletTransactions

export async function characterWalletTransactionsWorkflow() {
  'use workflow'
  const ids = await enumerateCharacters(['esi-wallet.read_character_wallet.v1'])

  // Static lane assignment (round-robin over the enumerated order), the
  // sde-mirror pattern: the id→step-call mapping is identical on every
  // replay regardless of how in-flight steps resolve. Within a lane,
  // characters run sequentially; lanes run concurrently.
  const LANES = 4
  const lanes: string[][] = Array.from({ length: LANES }, () => [])
  ids.forEach((id, i) => lanes[i % LANES].push(id))
  await Promise.all(
    lanes.map(async (lane) => {
      for (const id of lane) {
        await runCharacterStep('character-wallet-transactions', load, id)
      }
    })
  )
}
```

Notes:

- **Plain loops in the orchestrator body** are the documented exception to
  the ramda rule (see `src/workflows/sdeMirror.ts`'s comment): workflow
  bodies must be simple deterministic control flow, and helpers imported
  at workflow (non-step) level would execute in workflow context.
- **Lane count**: start at 4. The queue today runs messages with its own
  concurrency, so parallel per-character pulls are nothing new for ESI or
  Supabase; 4 keeps a big account polite to ESI's error-rate limits.
  It's a per-file constant — tune per job if heartbeat durations say so.
- **Retry blast radius**: a failed step retries just that character. Under
  the queue, a whole message (= one character too) retried, so this is
  parity — but the workflow won't retry forever; a character whose token
  is dead fails its step, and the run surfaces it in Observability instead
  of the queue silently re-looping. Decide per the pilot whether a single
  character's exhausted retries should fail the whole run (probably yes —
  visible is better than swallowed; the other lanes still complete because
  `Promise.all` only rejects after in-flight lanes settle their current
  steps... verify the semantics in the first PR and, if a lane abort
  cancels sibling steps, wrap `runCharacterStep` in a per-character
  try/catch that records the failure and continues, then rethrow a summary
  at the end).
- **`character-status`** enumerates with the any-of-scopes list
  (`selectCharacterIdsWithScopes` already unions; this is exactly what
  `fanOutPerCharacterAnyScopeCronJob` does today) and its handler already
  runs only the endpoints each token carries.

## As-built (PR 1: `character-wallet-transactions`)

The shape above is right in spirit; two things changed once it hit the runtime:

- **No function crosses a step boundary.** The sketch's
  `runCharacterStep(job, load, characterId)` passes `load` (a function) as a
  step argument, but Vercel Workflows serialize step inputs/outputs for durable
  replay and a function can't serialize (this is why `sdeIngestSteps.ts` steps
  take only `zipUrl`/`file`/`build`/`startLine`). So each workflow owns its own
  thin `'use step'` `syncCharacter(characterId: number)` that lazy-imports *its*
  job module — exactly the `characterImplants.ts` precedent — and only
  `characterId` (a bigint→number) crosses the boundary. The one genuinely
  shared step is `enumerateCharacters(scopes)` in `src/workflows/lib.ts`
  (serializable in, serializable out), imported at the workflow's top level like
  any step.
- **A failed character is caught, not fatal.** `Promise.all` rejects on the
  first lane rejection, and rather than rely on the runtime's in-flight
  cancellation semantics, each `syncCharacter` call is wrapped in try/catch: the
  lane records the failing id and continues, and a summary is rethrown after all
  lanes drain so the run is marked failed in Observability with every failing
  character listed. All characters are attempted regardless. Bounded per-step
  retries still happen inside the runtime before the `await` throws into the
  body. This is the "visible is better than swallowed" resolution the sketch
  flagged; the six remaining jobs copy this body.

## Cron routes and the queue consumer

- Each cron route swaps its `fanOutPerCharacter*CronJob(...)` call for the
  `start()` trigger shape.
- **Queue consumer `JOBS` entries stay untouched.** The on-demand "Refresh
  ESI" flow (`PER_CHARACTER_JOBS` in `dispatchRefresh.ts`, the per-cell
  refresh buttons, `refresh_task` tracking) keeps dispatching these jobs
  through the queue exactly as today. One job, two triggers, same `run*()`
  — the phase 5 doc decides whether the on-demand path also moves.
- The `character-implants` special-case in the consumer (the original
  pilot) also stays until phase 5.

## Interaction between scheduled and on-demand runs

Today a scheduled queue message and an on-demand one for the same
character can already run concurrently; per-character reconciles have
never shown the corp-style race (single writer per `character_id` per
message, and the overlap window is seconds). The workflow migration
neither fixes nor worsens this — noting it here so nobody mistakes it for
a regression when two heartbeat rows land close together.

## Verification (per PR)

README gates, plus:

- `/character/refresh` matrix goes green for the job across **all**
  characters after the scheduled firing (this is the per-character
  heartbeat check).
- For the SCD-2 jobs (#2 onward): compare the current-view row count
  before/after the first workflow run (`character_order`,
  `character_industry_job`, `character_blueprint`, `character_asset`) — a
  reconcile bug shows up as rows vanishing.
- For the ETag jobs (#1–#3): confirm `esi.conditional_request` metric
  lines still show `not_modified` hits from workflow-run invocations.
- Run one on-demand refresh for one character to confirm the queue path
  still works beside the workflow path.
