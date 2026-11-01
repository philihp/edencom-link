# The structure-measure rollup

`/structure` and `/structure/[structureId]` show, per structure, Revenue, Taxes
Paid (exact and estimated), Cost Avoidance, Your Total EIV and a Characters tab.
Until this change every one of those was refolded per request from raw rows:
every current row of both industry-job views the caller could read (co-tenants'
included), every `industry_job_tax` journal entry in the window, the rest
resolved through `industry_job_tax_facility()`, then priced and folded in
TypeScript. #1208 paged and parallelised that; it stayed linear in job history.

The figures cannot be computed at build time — every one is RLS-scoped to the
signed-in account — so they are precomputed where the sources are written: the
three extracts maintain two per-day tables, and the pages sum a window of days
with one indexed select per table. The same move `industry_system_index_bucket`
made for the sparklines, and the one docs/page-load-performance.md prescribes
for the asset summary.

## The tables

Both are keyed `(structure_id, owner_key, utc_day)`, with `owner_key` folding
`registration_id` xor `corporation_id` into one generated column the way
`heartbeat` and `structure_tenant` do. Service-role writes only.

**`structure_measure_day`** — owner-only RLS (own registrations, own
corporations via `my_corporation_ids()`), the predicates the job tables use.

| column                                             | meaning                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs`                                             | jobs this owner holds, installed here that day, any activity                                                                                                                                                              |
| `revenue`, `revenue_by_payer`                      | corporation rows: `industry_job_tax` received into this corporation's wallet for jobs run here, dated by the entry; the jsonb is `{ first_party_id: isk }`                                                                 |
| `tax_paid`, `tax_paid_by_landlord`                 | facility tax this owner's jobs were charged, once per job; the jsonb is `{ corporation_id: isk }`                                                                                                                         |
| `own_job_tax`, `own_job_tax_jobs`                  | the cost-avoidance basis: every charge on a job of this owner's, with its job count                                                                                                                                       |
| `eiv`, `eiv_jobs`                                  | registration rows: Your Total EIV — the ME0 bill of every manufacturing/reaction job this registration's character installed, personally or as a corporation, priced at `market_adjusted_price` as it stood when computed |
| `recovered_tax`, `recovered_eiv`, `recovered_jobs` | the recovered facility tax (`eiv.ts`) over the subset of those jobs the journal did not bill, with the cost index in effect at install                                                                                    |
| `unpriced_jobs`                                    | jobs that would have counted but lacked a bill, a price or an index                                                                                                                                                       |

`structure_id` 0 is "the entry named no job we hold": revenue that could not be
tied to a structure, and outgoing tax for a job the corporation's extract never
listed.

**`structure_installer_day_all`** (+ view `structure_installer_day`) — the
Characters tab. Readable by the owner and by every tenant of the structure
(`my_tenant_structure_ids()`, the audience that reads each other's current
jobs). A registration row is one character (`character_id`), a corporation
row is the corporation with `installer_ids` the distinct installers. A job
hidden through `industry_job_hidden` keeps its share in `hidden_jobs` /
`hidden_eiv` / `hidden_installer_ids`, which the view blanks for anyone but the
owner — the same trick the job views play with `cost`.

Two RPCs beside them: `structure_measure_structure_ids()` (invoker rights; the
player structures the caller's own jobs ran in, for the roster's discovery of
structures no director scans — rows with `jobs` or `eiv_jobs`, never
revenue-only ones) and `industry_index_at(probes)` (the `market_price_at()`
shape over `industry_system_index`: for each `{ key, system_id, activity,
as_of }` the latest sample at or before the moment, else the earliest after).

## Why per owner, and what that decides

The page's figures are per account, and an account is a set of owners, so
every figure has to be decomposable: an account's Revenue is the sum over its
corporations' rows, its EIV the sum over its registrations'. That decides
where each charge is filed (`src/app/structure/measureRollup.ts`, the pure
write-side fold):

- **A job's facility tax is filed once, under the wallet that paid it.** A job
  installed as a corporation bills the corporation's wallet — the outgoing
  entry — so it is the corporation's charge. A personal job bills the
  character's wallet, which has no journal here; the receipt in the landlord's
  wallet is its only record, so the registration takes it, but only when no
  outgoing entry names the job (ESI's character listing carries corp-installed
  jobs too, and those are already the corporation's). A corp-listed job whose
  installer is registered nowhere files its receipt under the corporation as
  `own_job_tax` only: not tax _we_ paid, but a charge on a job of the
  corporation's, which the old fold counted toward avoidance.
- **EIV is filed under the registration whose character installed the job**,
  personally or as a corporation, one per job id. Your Total EIV counts only
  jobs our own characters installed (#1180), and a corporation's row cannot
  know which of its installers the reader holds. A corp job with an
  unregistered installer is nobody's throughput, as before.
- **Revenue is filed under the corporation whose wallet received it**, at the
  structure the job ran in (resolved over both job tables, any owner — what
  `industry_job_tax_facility()` did for the page), else at structure 0.
- **The Characters tab files a job under the corporation when the corp extract
  lists it** (a corp attribution wins, as `installers.ts` ruled), and prices
  every job whoever installed it (#1192), so its rows still add up to more than
  the tile.

What is _not_ decomposable per owner is stored as a basis and decided when
read (`src/app/structure/measureWindow.ts`, the pure read-side fold):

- `own_job_tax` counts toward cost avoidance only where one of the reader's
  corporations owns the structure; paying a landlord we don't own is rent.
  Cost avoidance itself stays the read-time multiply `costAvoidance.ts` always
  was, over the receipt total and the reader's two rates from `/settings/tax`.
- `recovered_tax` stands only where no journal of the reader's covers the
  structure's owner (`journalCoverage.ts`, still one existence probe per
  candidate corporation), since the exact row wins there.
- A row at a structure with no tile is not lost: its revenue is
  **unaccounted** (`revenue_by_payer` merged into the breakdown by payer), its
  tax paid is **taxes paid elsewhere** (`tax_paid_by_landlord` merged by
  landlord, with the structures' systems from `universe_structure`) — unless
  the landlord has a tile here, in which case the job merely failed to resolve
  and it is dropped rather than guessed at, as before.

## The writers

`src/jobs/structureMeasures.js` rebuilds one owner over a day range from its
sources — its jobs (a registration's personal jobs plus the corp-table jobs
its character installed; a corporation's corp-table jobs and its wallet's tax
entries), every tax entry naming those jobs from every wallet, bills from
`sde_blueprint_product`, prices, each structure's system and hull, the index at
each install, hidden jobs, which installers are registered — folds, upserts
the rows stamped with the run's `computed_at`, and deletes the owner's older
rows in the range. **Recompute, never increment**: idempotent, so a retry can
only converge, and the backfill is the same code over all time.

The three extracts call it best-effort after their own writes commit, the way
`recordStructureTenancy` is called:

| extract                   | rebuilds                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `character-industry-jobs` | the registration, over the days of the jobs the reconcile opened or aged out                                                                                                                |
| `corp-industry-jobs`      | the corporation plus every registration whose character installed one of those jobs, same days                                                                                             |
| `corp-wallet-journal`     | the corporation over the days its pulled tax entries fall on (revenue), plus the owners of the jobs the entries of the last two days name, so a charge folded before its entry arrived is filed and its recovery switched off |

Order between extracts does not matter: a job folded before its entry is
re-folded when the entry arrives; an entry pulled before its job is re-folded
when the job extract runs.

**Backfill**: `pnpm run structure-measures` rebuilds every owner (all
registrations, and every corporation a registration sits in, a tenancy row
names, a corp extract was tried for, or a scanned structure belongs to) over
all time; `--since YYYY-MM-DD` bounds it. Run once after the migration, and
again if the pricing rules change. It is not scheduled.

**Skipping it blanks the page, quietly.** #1209 merged without it: for the
first eleven hours the rollup held only what the extracts had recomputed
since the deploy — 45 of ~216 owners, 803 jobs with EIV in a 30-day window
against ~24,000 current jobs — so Revenue survived (the journal extract refolds
its 30 days every run) while EIV, Taxes Paid, Cost Avoidance and the
Characters tab went mostly empty. Nothing errored and no test could see it:
the folds were right, they were just reading an empty table. Run on
2026-11-01 with `--since 2026-08-01` (the page's widest window is 90 days):
217 owners in ~7 s, 6,492 measure rows, 24,467 jobs in the 30-day window.

## What changed for the reader

- **The window is whole UTC days.** Days from the one `now − N days` falls on,
  so up to a day wider than the exact instant the page used.
- **Pricing freezes at compute time.** `market_adjusted_price` is latest-only,
  so the page used to price every job in the window at today's adjusted
  prices; a rollup row keeps the prices of the run that computed it (the
  backfill prices history at today's). The cost index is now the sample in
  effect at install from the whole history, not only the window's samples.
- **A personal job's receipt is seen through any wallet the deployment
  holds**, not only the reader's corporations' — it is the character's own
  payment. The reverse narrowing: a charge is filed under the entity whose
  wallet paid it, so an account holding a corporation but not the installer's
  registration (registered on another account) no longer sees that member's
  receipt toward its avoidance.
- Older journal entries with no `context_id` (the page scraped job ids out of
  their descriptions) are not attributed.
- A character registered on two accounts counts once per registration on the
  Characters tab for co-tenant viewers (the page deduped by job id).

## Verifying

`test/structureMeasureRollup.test.ts` and `test/structureMeasureWindow.test.ts`
pin the filing and reading rules; `test/sql/structure_measure_rollup.sql` the
RLS predicates, the view's masking and the two RPCs. After the migration and
backfill, a fresh account and a long-history one should both render
`/structure` with the same figures as before for the same window, and the page
should issue no select against either industry-job view.

## Where the remaining time went

Measured 2026-11-01, after the backfill, from production:

- **Vercel metrics** (`vercel metrics vercel.function_invocation.function_duration_ms
  --prod -f 'route:"/structure"'`): the function runs in `sfo1`, next to the
  database in `us-west-1`, so a round trip costs milliseconds and the number
  of sequential stages is not what costs seconds. Since the rollup deploy:
  p50 16 ms (prefetches), p90 1.66 s, worst hours 8–9 s.
- **`pg_stat_statements`**, filtered to the queries the page issues: the
  rollup reads are cheap — `structure_measure_day` 10.9 ms mean, the
  installer view 26.9 ms, `structure_measure_structure_ids()` 18.6 ms. What
  wasn't:

  | read                                                                  | mean   | worst |
  | --------------------------------------------------------------------- | ------ | ----- |
  | `industry_system_index` newest `recorded_at`                          | 482 ms | 2.0 s |
  | `industry_system_index` rows at that `recorded_at` (waits on the one above) | 819 ms | 2.3 s |
  | clone-bay journal (`ref_type in (…) and date >= …`)                  | 249 ms | 1.8 s |
  | `industry_system_index_bucket` sparklines                             | 77 ms  | 1.8 s |

  `industry_system_index` is append-only (640k rows, 2,497 snapshots) and
  its one index leads with `system_id`, so `fetchLatestSystemIndexes()` made
  two whole-table passes in series — the longest leg of the page's third
  stage, which waits on all its reads together. The clone footer walked every
  corporation's journal window under `corp_wallet_journal_corp_date_idx` and
  filtered on `ref_type`.

Migration `20261101173740_structure_latency_indexes` adds
`industry_system_index (recorded_at desc)` (one probe, then one snapshot's
~560 rows; `/indexes`, `/structure/[structureId]` and MCP
`industry_cost_indices` share the function) and `corp_wallet_journal
(ref_type, date desc)`. The page itself starts the clone-bay journal and the
`corp-structures` heartbeat with the first stage instead of after the last,
and runs the two footer lookup chains (unlisted landlords; unaccounted payers)
side by side; `measures.ts` asks the character directory and the corporation
directory together. The sparkline view is left as it is: 77 ms mean, and its
worst cases coincide with the hours the extracts write.
