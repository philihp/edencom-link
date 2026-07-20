# Phase 2: the account-wide queue jobs → single-step workflows

`universe-names` (every 6h `:58`) and `character-affiliations` (11:41
daily). Today their cron routes call `dispatchAccountCronJob`
(`src/utils/cron.ts`), which sends **one** queue message; the consumer
(`src/app/api/queue/jobs/route.ts`) runs the batch and records the
whole-job heartbeat itself (`source: 'vercel'`).

## Why second

Same single-batch execution shape as phase 1 — the workflow is the same
one-step wrapper — but this phase is the first to **take a path off the
queue**, so it's the first place a behavioral difference could hide:

- Queue retry semantics (`retryAfterSeconds: 60`, message-level) are
  replaced by Workflows' bounded step retries.
- The heartbeat writer moves from the queue consumer into the step.

Both jobs are benign to re-run: `universe-names` upserts id→name rows into
`universe_name` (plus the `resolve*` sweeps, all upserts); `character-
affiliations` upserts `character_affiliation` and refreshes
`registration.corporation_id`. No SCD-2, no pagination, no per-character
tokens (both use public ESI endpoints).

## Steps

1. **Workflow files** — identical shape to phase 1, reusing `runJobStep`
   from `src/workflows/lib.ts`:

   ```ts
   // src/workflows/universeNames.ts
   import { runJobStep } from './lib'

   export async function universeNamesWorkflow() {
     'use workflow'
     await runJobStep('universe-names', async () => (await import('@/jobs/universeNames.js')).runUniverseNames)
   }
   ```

   Same for `characterAffiliations.ts` → `runCharacterAffiliations`.

2. **Cron routes** — swap `dispatchAccountCronJob(job)` for the
   `start()` trigger shape (phase 1, step 3).

3. **Queue consumer: leave the `JOBS` entries alone.** The
   `'character-affiliations'` and `'universe-names'` entries in the
   consumer's registry stay, because `dispatchRefresh.ts` still enqueues
   them account-wide when a user adds a character (`ACCOUNT_JOBS`). Only
   the *scheduled* trigger moves. (The on-demand path is phase 5's
   decision.) The consumer's whole-job heartbeat block keeps working for
   those on-demand runs; scheduled runs now get their pair from the step —
   the `source` column ('vercel' vs 'vercel-workflow') tells them apart.

4. **`dispatchAccountCronJob`**: after both routes flip, nothing calls it —
   but delete it in phase 5 with the other helpers, not here, to keep
   these PRs pure job migrations.

## Verification

Per the README gates, plus:

- After the scheduled `universe-names` firing, confirm new/updated rows in
  `universe_name` and that the heartbeat pair carries
  `source: 'vercel-workflow'`.
- After `character-affiliations`, confirm `registration.corporation_id` is
  still being kept fresh (the corp-table RLS keys off it — a silent
  failure here would eventually break corp pages for users who change
  corps).
- Exercise the on-demand path once (add-character flow or
  `/character/refresh`) to confirm the queue entries still work untouched.

One PR can cover both jobs — they're the same change twice and share the
blast radius.
