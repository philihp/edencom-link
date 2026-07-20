# Phase 4: the per-corporation jobs → fan-out workflows

`corp-wallet-transactions`, `corp-industry-jobs`, `corp-assets` — the
three jobs whose cron routes today group scoped characters by corporation
and send **one queue message per corp** (`fanOutPerCorporationCronJob`).

## Why last

These carry the project's scar tissue. Two concurrent reconciles of the
same corp's rows once corrupted the SCD-2 data — the losing invocation
aborted mid-reconcile on a duplicate-key collision with rows already
closed (`is_current: false`) but never reopened, so real items vanished
from the views until a later run reinserted them. The entire
one-message-per-corp shape, and the fall-back-through-characters logic in
`forEachCorporation` (a token can carry the OAuth scope without the
in-game director/accountant role the endpoint separately requires), exist
because of that incident. Read the long comment on
`fanOutPerCorporationCronJob` in `src/utils/cron.ts` before touching
anything.

The migration is actually a *structural improvement* here — "one step per
corp, never two concurrent for the same corp" becomes control flow instead
of a queue-shape convention — but it must land after the fan-out pattern
(phase 3) has run in production for a while, because a mistake reconciles
corp hangars wrongly, which is the most painful data class in the app.

## In-phase order

| # | Job | Write pattern | Why this slot |
|---|---|---|---|
| 1 | `corp-wallet-transactions` | keyed append (`corp_wallet_transaction`, per division) | No reconcile at all — a concurrent or retried run is harmlessly idempotent. Proves the per-corp enumeration + step shape. |
| 2 | `corp-industry-jobs` | SCD-2 (`corp_industry_job_over_time`) | Reconciler, but modest volume. |
| 3 | `corp-assets` | SCD-2 (`corp_asset_over_time`) + `corp_structure_rig`, paginated | The original race victim: biggest volume, paginated, most user-visible. Last, deliberately. |

One PR per job. Watch a full scheduled cycle between them.

## The workflow shape

Same lanes as phase 3, but the fan-out unit is a **corp group** — the
ordered character list `forEachCorporation` falls back through:

```ts
// src/workflows/lib.ts (addition)
export async function enumerateCorporations(scope: string): Promise<string[][]> {
  'use step'
  const { groupCharacterIdsByCorporation } = await import('@/supabase.js')
  const { byCorp, unresolved } = await groupCharacterIdsByCorporation([scope])
  // Same fan-out set fanOutPerCorporationCronJob builds today: one group
  // per corp, plus singleton groups for characters with no resolved corp.
  return [...byCorp.values(), ...unresolved.map((id) => [id])]
}

export async function runCorporationStep(
  job: string,
  load: () => Promise<(opts: { characterIds: string[] }) => Promise<unknown>>,
  characterIds: string[]
) {
  'use step'
  const run = await load()
  await run({ characterIds })
}
```

```ts
// src/workflows/corpAssets.ts
import { enumerateCorporations, runCorporationStep } from './lib'

const load = async () => (await import('@/jobs/corpAssets.js')).runCorpAssets

export async function corpAssetsWorkflow() {
  'use workflow'
  const groups = await enumerateCorporations('esi-assets.read_corporation_assets.v1')

  const LANES = 2
  const lanes: string[][][] = Array.from({ length: LANES }, () => [])
  groups.forEach((group, i) => lanes[i % LANES].push(group))
  await Promise.all(
    lanes.map(async (lane) => {
      for (const group of lane) {
        await runCorporationStep('corp-assets', load, group)
      }
    })
  )
}
```

Invariants to preserve — check each against the code, not from memory:

- **Exactly one step per corp per run.** A corp's characters all ride in
  one step's `characterIds`; `forEachCorporation` inside the job dedupes
  to one handler call and falls back through the list on role failures.
  Never split a corp's characters across steps — that would recreate the
  race the queue shape was built to kill.
- **Step retries are serial, and that's why they're safe.** A retried
  reconcile after a partial failure just converges (the incident was
  *concurrent* reconciles, not re-runs). Nothing else may write the same
  corp's rows while the workflow runs — which holds, except for the
  on-demand path below.
- **Lanes only parallelize *different* corps** (each corp's rows are
  disjoint). `LANES = 2` because the corp count is small and corp pulls
  are the heaviest (paginated hangars); even `LANES = 1` (fully
  sequential) is acceptable if the daily window allows.

## The on-demand path still exists — same race surface as today

`PER_CORPORATION_JOBS` in `dispatchRefresh.ts` dispatches these same jobs
through the queue (one message per corp) when a user adds a character or
clicks refresh. A scheduled *workflow* step and an on-demand *queue*
message for the same corp could theoretically overlap — but that exact
overlap already exists today between a cron-enqueued message and an
on-demand one. Parity, not regression. Phase 5 removes the duality; until
then, prefer running phase-4 verification at times away from the daily
09:xx corp schedule.

## Verification (per PR)

README gates, plus — this phase gets the strictest checks:

- Before/after row counts on the current views (`corp_asset`,
  `corp_industry_job`) and spot-checks of a few known items after the
  first workflow-run reconcile. The failure mode being hunted: items
  closed and not reopened.
- Confirm the per-corp heartbeat rows (attributed
  `corporation_id`/`character_id`/`user_id`) still land from inside the
  step, and their durations vs. the old queue runs (`corp-assets` is the
  one to watch for step-budget pressure; if it trends toward the limit,
  the escape hatch is the `sde-mirror` cursor-slice pattern inside the
  job — a later, separate change).
- Deliberately test the role-fallback: if a corp has a scoped character
  without the director role ordered first, confirm the step still
  succeeds via a later character (this is `forEachCorporation` behavior,
  but the step boundary must not change it).
