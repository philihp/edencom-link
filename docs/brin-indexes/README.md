# BRIN as the standard time-travel index for the SCD-2 tables

> **Status: adopted, rollout pending.** This doc supersedes the earlier
> "survey and plan" version, whose posture was "measure, and possibly stop."
> The posture is now **standardize, measured**: every `*_over_time` table gets
> a BRIN on `valid_from`, one migration PR at a time, with the gains (and any
> regressions) read off live endpoint timings — the `request.timing` metric
> (`src/observability.js`) that instruments the CSV/link/GraphQL surfaces —
> plus `EXPLAIN` evidence at production row counts. What changed since the
> survey: the SCD tables now have a uniform, user-facing time-travel access
> path worth serving well, and the instrumentation to watch it exists.

## The finding that anchors this

While sizing `market_price_over_time`, swapping its as-of index from btree to
BRIN measured, at 2M rows:

|                                   | btree `(market, valid_from desc)` | BRIN `(valid_from)` |
| --------------------------------- | --------------------------------- | ------------------- |
| Size                              | 60 MB                             | **40 kB**           |
| Deep-history query (0.6% of rows) | 2.6 ms                            | 5.1 ms              |
| Mid-history query (74% of rows)   | 166 ms (index unused)             | 181 ms              |

A **1500× smaller index for ~2.5 ms**. And it survives churn: after 60
simulated hourly cycles running the job's real touch/close/insert statements,
`valid_from`'s correlation with physical order was still **0.9996** — the
`is_current` flips that move tuples do not scatter the index. Full method in
[docs/market-prices/README.md](../market-prices/README.md) "Storage".

## Why this generalizes to every SCD-2 table

The tables share one write pattern and one read pattern, by construction:

- **Writes append.** Every reconcile bumps `valid_until` on unchanged rows in
  place, closes vanished rows in place, and _appends_ new versions — so
  `valid_from` climbs with block number on every `*_over_time` table, exactly
  the correlation BRIN needs.
- **Time travel is a range predicate the btrees can't serve.** Every snapshot
  function (`character_asset_snapshot_at`, `character_orders`,
  `character_industry_jobs`, `corp_industry_jobs`, `market_price_snapshot`)
  asks the same shape:

  ```sql
  where <owner> = any(...)
    and valid_from <= as_of
    and (is_current or valid_until >= as_of)
  ```

  The `or` defeats a btree on `(entity_id, valid_until desc)`; the
  `valid_from <= as_of` half is a textbook BRIN range scan. Today **no
  `*_over_time` table except `market_price_over_time` has any index on
  `valid_from` at all** — the time-travel branch seq-scans.

## The standard

Every `*_over_time` table carries:

```sql
-- Time travel: valid_from climbs with physical order (the reconcile appends),
-- so a BRIN serves `valid_from <= as_of` at ~kB size. Measured precedent and
-- churn-survival numbers: docs/brin-indexes/README.md.
create index <table>_asof_idx on public.<table>
  using brin (valid_from) with (pages_per_range = 32);
```

All 13 tables — the 12 without one today plus `market_price_over_time`, the
precedent: `character_asset_over_time`, `character_blueprint_over_time`,
`character_order_over_time`, `character_industry_job_over_time`,
`character_clone_over_time`, `character_skill_over_time`,
`character_ship_over_time`, `character_fitting_over_time`,
`character_mercenary_den_over_time`, `corp_asset_over_time`,
`corp_blueprint_over_time`, `corp_industry_job_over_time`.

**Small tables get one too.** The earlier plan gated on "> ~1 GB", reasoning
that small tables don't matter. Inverted: a BRIN on a 50k-row table costs
kilobytes and near-zero write overhead, and standardizing means every table is
already correct when it grows and every time-travel query plans the same way —
uniformity is cheaper than a per-table debate nobody re-opens at the right
moment. (Tables with no snapshot function yet — clone/skill/ship/fitting/
mercenary-den — are included for the same reason: the index is the cheap half;
the RPC, when someone wants one, is the expensive half.)

### Where `pages_per_range = 32` comes from, and how to recalibrate it

**Provenance, honestly:** 32 is inherited from the `market_price_over_time`
precedent. The market-prices sizing work ran its benchmarks _with_ 32 — the
5.1 ms / 181 ms numbers above were measured at that setting — but never A/B'd
it against PostgreSQL's default of 128. It is a reasonable value carried
forward, not a measured optimum, and the standard keeps it for uniformity
until a measurement says otherwise.

**What the knob trades.** A BRIN entry is one min/max summary per
`pages_per_range` heap pages. At 32 that's one summary per 256 kB of heap —
4× finer than the default. Finer granularity means a range predicate matches
fewer irrelevant blocks, so the lossy recheck reads fewer heap pages per
query; the cost is proportionally more summary entries, which at BRIN scale
(~tens of bytes each) keeps the index in kilobytes at any plausible table
size. That asymmetry — recheck I/O is the real cost, index bytes are nearly
free — is why the standard errs fine rather than coarse.

**Recalibrating, when the numbers ask for it:**

- Run `EXPLAIN (ANALYZE, BUFFERS)` on the table's time-travel query at
  production row counts and read the `Buffers: shared hit/read` line against
  the rows the query actually returned. Heap pages read ≫ what the result
  warrants means the summaries are too coarse for how the predicate selects —
  **halve** `pages_per_range` and re-measure. (A BRIN rebuild is a cheap,
  single-pass migration; ship it like any index change, numbers in the
  comment.)
- The index itself showing up meaningfully in the sizing query — which takes
  extreme row counts at these entry sizes — is the signal to **raise** it.
- Re-check whenever the periodic `pg_stats.correlation` health check runs (a
  degrading correlation and a wrong granularity present the same way: more
  blocks scanned per query), and after any change to a reconcile's write
  order.
- A per-table value is allowed when measured — the standard is "recorded and
  reasoned", not "identical forever" — but the migration comment must carry
  the before/after numbers like every other index choice here.

### What stays, what might go

- **Keep** the `(<entity>_id, valid_until desc)` btrees: high-cardinality
  equality probes (`asset_share_covers`'s per-node lateral lookup, the
  `distinct on (item_id)` walkers) have no correlation to exploit — BRIN is
  wrong for them.
- **Keep** the `where is_current` partial uniques: they are the identity
  constraint, the reconcile's conflict target, and the live-path index.
- **Owner btrees (`(registration_id)` / `(corporation_id)`) are drop
  candidates, not conversion candidates.** Very low cardinality; RLS and the
  snapshot functions filter on them, but usually alongside predicates the
  other indexes serve. Decide per table from `pg_stat_user_indexes.idx_scan`
  over a real window (the third Phase-1 query below); each drop is its **own
  PR, never bundled with a BRIN add** — a plan regression must be
  attributable to exactly one change. The market-prices work already found one
  60 MB btree the planner never chose; expect more.

### Migration mechanics

- Plain `create index` in a normal migration. The Supabase CLI applies
  migrations transactionally, so `concurrently` is unavailable — and
  unnecessary: a BRIN build is one sequential heap pass, and the writers it
  would briefly block are the 6-hourly extract jobs. Merge away from the
  busiest cron minutes (`vercel.json`) for the large tables.
- Every migration edits `schema.sql` too (source of truth), never renames an
  existing migration, and **records the measured numbers in its comment** the
  way `20260816040000_market_price.sql` does — a future reader must be able to
  tell whether the choice was reasoned or copied.
- Naming: `<table>_asof_idx`, matching the precedent.

## Measurement protocol (per table PR)

The point of standardizing _measured_ is that every claim below is checkable
in Vercel Observability, not a rerun of someone's laptop benchmark.

### 1. Baseline window

≥7 days of `request.timing` (metric emitted by `src/observability.js`,
ingested from function logs) before the migration merges, grouped by
`route` + `field`, split on `served`:

- `served='historical'` — requests that exercised the time-travel predicate
  (an explicit `at=`). Record p50/p95 `duration_ms` and typical `rows`.
- `served='live'` — the current-rows path (link CSV, GraphQL, legacy without
  `at=`). This is the regression guard: the BRIN must not change these plans.

Organic historical traffic may be thin — links are deliberately current-only
(docs/sharing-layer/09-sheets-parity.md), so `at=` arrives only through the
legacy CSV routes and `/sheets/market/[market]`. So each PR also runs a
**synthetic probe**: a scripted loop hitting the table's `at=` endpoint at
fixed offsets (1 day / 30 days / 90 days back) a few dozen times, from the
same region, before and after — enough samples for a stable p50 either side.
The probe's requests land in the same metric with `served='historical'`;
nothing special to build.

### 2. Plan-level evidence

`EXPLAIN (ANALYZE, BUFFERS)` of the serving RPC's query at **production row
counts**, before and after, plus `pg_relation_size` of every index touched.
Use a production read-only session or a restored copy — a Supabase preview
branch clones schema, not data, and an empty table's plan proves nothing.

### 3. Apply, compare, accept

Merge the migration, run an equal-length comparison window (and re-run the
synthetic probe). Acceptance:

- `served='live'` p50/p95 not regressed for the routes reading this table;
- `served='historical'` improved or neutral (the market-price precedent says
  "a few ms slower deep-history is fine" — the win is the index size, which
  gets recorded);
- index sizes recorded in the migration comment closed out with the real
  numbers.

A regression reverts the one migration — which is why each table ships alone.

### 4. Health, ongoing

- **BRIN degrades silently**: correlation drops, queries slow, nothing
  errors. Re-run the correlation query below periodically (fold it into
  whatever check next touches this area) and re-check after any change to a
  reconcile's write order.
- **Summarisation lags inserts**: new heap blocks aren't summarised until
  autovacuum runs or `brin_summarize_new_values()` is called, so the newest
  rows fall back to a scan. Harmless for history queries, which is all this
  index serves. `autosummarize=on` is the recorded open question — the
  market-price index doesn't set it; revisit if p95 on fresh-history probes
  looks worse than stale-history ones.

## Table → probe map

Which timing series measures which table. `field` is the metric's dimension.

| Table                                                                               | Historical probe                                             | `field`                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `character_asset_over_time`                                                         | `/api/character/assets?at=`                                  | `character_asset_snapshot_at`                    |
| `character_order_over_time`                                                         | `/api/character/orders?at=`                                  | `character_orders`                               |
| `character_industry_job_over_time`                                                  | `/api/character/jobs?at=`                                    | `character_industry_jobs`                        |
| `corp_industry_job_over_time`                                                       | `/api/corp/jobs?at=`                                         | `corp_industry_jobs`                             |
| `market_price_over_time`                                                            | `/sheets/market/[market]?at=` (the control — BRIN'd already) | `market_price_snapshot`                          |
| `character_blueprint_over_time`, `corp_asset_over_time`, `corp_blueprint_over_time` | none — their RPCs are live-only                              | EXPLAIN-only evidence, stated honestly in the PR |
| `character_clone/skill/ship/fitting/mercenary_den_over_time`                        | none — no snapshot RPC exists                                | EXPLAIN-only evidence                            |

The live-path guard for every table is the same tables' `served='live'`
series: `link_csv`/`graphql` (`assets`, `blueprints`, `industryJobs`,
`marketOrders`) and the legacy routes without `at=`.

The MCP `list_market_orders`/`list_industry_jobs` tools take `as_of` and call
the same RPCs — they benefit identically but aren't instrumented; the CSV
routes are the measured proxy.

## Pre-flight queries (kept from the survey)

Still the right first move before each PR — sizing, correlation, and the
index-usage read that decides owner-btree drops. Against production,
read-only:

```sql
-- Which tables are actually large, and how much of each is index?
select relname,
       pg_size_pretty(pg_total_relation_size(c.oid))                as total,
       pg_size_pretty(pg_relation_size(c.oid))                      as heap,
       pg_size_pretty(pg_indexes_size(c.oid))                       as indexes,
       (select reltuples::bigint from pg_class where oid = c.oid)    as est_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 25;

-- Is valid_from actually correlated with physical order? Below ~0.9,
-- investigate the table's reconcile before indexing it — that would mean the
-- append assumption broke somewhere.
select tablename, attname, correlation, n_distinct
from pg_stats
where schemaname = 'public'
  and attname in ('valid_from','valid_until','registration_id','corporation_id')
order by tablename, attname;

-- Which indexes is nobody using? A never-scanned owner btree on a big table
-- is a drop candidate (its own PR).
select relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where schemaname = 'public'
order by pg_relation_size(indexrelid) desc
limit 30;
```

## Sequencing

1. ~~Instrument the serving endpoints~~ — done: `request.timing` covers the
   seven CSV routes, `/sheets/market/[market]`, the link viewer/CSV, and
   `/api/graphql`, with the `served` live/historical split.
2. **PR: small-table batch.** One migration adding the BRIN to the tables the
   sizing query shows as small (expected: clone, skill, ship, fitting,
   mercenary-den, and possibly blueprints). EXPLAIN evidence only; batching is
   safe exactly because these can't regress anything measurable.
3. **One PR per large table**, in descending size order (expected: assets,
   then orders/industry jobs — confirm with the sizing query), each running
   the full protocol above.
4. **Owner-btree drops**, per `idx_scan` evidence, one PR each, after the
   BRIN adds have settled.
5. **Fillfactor experiment** (below), last and independent.

## The adjacent project: churn, not indexes

Kept from the survey because the numbers were striking: the market-prices
simulation measured 267k live rows occupying 143 MB — dead tuples from the
hourly `valid_until` touch, not row width. **Every SCD-2 table does that same
touch every 6 hours.** If the sizing query shows heap ≫ live-row estimate on
the big tables, the higher-value fix is a measured `fillfactor` experiment on
one mid-size table:

- `alter table <t> set (fillfactor = 90)` affects only future pages;
  reclaiming existing bloat needs `vacuum full`/`pg_repack`, which is out of
  scope here.
- Track `pg_stat_user_tables.n_dead_tup` and heap size over two weeks against
  an untouched sibling table.
- HOT updates are the mechanism to verify: with free space per page, the
  `valid_until` touch can stay on-page instead of appending a dead tuple —
  which _also_ protects the BRIN correlation, since fewer relocations means
  the append order stays clean.

Separate follow-up; does not block the index rollout.

## Risks and non-goals (unchanged in spirit)

- **Not a btree replacement** for high-cardinality equality (`item_id`,
  `job_id`, `order_id` probes stay btree).
- **Not a substitute for retention.** BRIN shrinks the index; a table large
  because it keeps everything forever still wants a retention policy —
  cheaper to keep is not the same as worth keeping.
- **Non-goal: latency wins.** The measured precedent trades a few ms on
  deep-history reads for three orders of magnitude of index size. The
  acceptance bar is "no live-path regression, historical neutral-or-better",
  not "faster".
