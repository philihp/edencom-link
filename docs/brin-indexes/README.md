# BRIN indexes for the append-ordered tables: survey and plan

> **Status: proposed, nothing done.** `market_price_over_time` is the only
> table in the schema using BRIN today (added with the market-prices capture —
> [docs/market-prices/README.md](../market-prices/README.md) "Storage"). This
> doc asks whether the same trick applies to the other growth tables, and
> deliberately does **not** answer it: the first phase is measurement, because
> the answer depends on production row counts nobody has looked at.

## The finding that prompted this

While sizing `market_price_over_time`, swapping its as-of index from btree to
BRIN measured, at 2M rows:

| | btree `(market, valid_from desc)` | BRIN `(valid_from)` |
|---|---|---|
| Size | 60 MB | **40 kB** |
| Deep-history query (0.6% of rows) | 2.6 ms | 5.1 ms |
| Mid-history query (74% of rows) | 166 ms (index unused) | 181 ms |

A **1500× smaller index for ~2.5 ms**. And it survives churn: after 60 simulated
hourly cycles running the job's real touch/close/insert statements,
`valid_from`'s correlation with physical order was still **0.9996**, so the
`is_current` flips that move tuples do not scatter the index.

## Why it worked there, which is the whole question

BRIN stores one min/max summary per *range of blocks* instead of one entry per
row. That is only useful when the table's **physical order correlates with the
indexed column**, and only for **range** predicates. `market_price_over_time`
satisfies both by construction: every run appends its changed rows at the end of
the heap, so `valid_from` climbs with block number, and time travel asks
`valid_from <= X`.

Two things it is *not*:

- **Not a general btree replacement.** An equality lookup on a high-cardinality
  column (`item_id`, `job_id`, `order_id`) has no correlation to exploit and
  gets a lossy scan of many blocks instead of a direct probe. Those indexes must
  stay btree.
- **Not free on a leading equality column.** `(registration_id, date desc)` is
  efficient because the btree seeks straight to one owner's rows. A BRIN on
  `date` alone loses that seek and filters every candidate block on recheck.
  Whether that is a win depends entirely on how many rows the owner filter
  removes — i.e. on how many registrations exist, which is a production fact.

## Survey: every index on a table that grows without bound

Grouped by whether BRIN could plausibly apply. **No sizes here on purpose** —
see Phase 1.

### Group A — plausible candidates: append-ordered, range-queried

| Table | Index today | Correlated column | Note |
|---|---|---|---|
| `heartbeat` | `heartbeat_ran_at_idx (ran_at desc)` | `ran_at` | Purely append-only, never updated. The cleanest candidate in the schema. |
| `heartbeat` | `heartbeat_job_ended_at_idx (job, ended_at desc)` | `ended_at` | Leading equality on `job` (low cardinality — one value per extract job), so a BRIN on `ended_at` plus a recheck on `job` may beat it. Backs `latest_heartbeats()`. |
| `industry_system_index` | `(system_id, activity, recorded_at desc)` | `recorded_at` | Explicitly append-only ("so the indices' drift over time can be charted"). Point lookups by system+activity are the current shape though — see Phase 2. |
| `character_mercenary_den_status` | `character_mercenary_den_status_den_idx` | `observed_at` | Append-only observations. |
| `character_wallet` | `(registration_id, recorded_at desc)` | `recorded_at` | Balance history, append-only. |
| `character_wallet_transaction` | `(registration_id, date desc)` | `date` | ESI returns transactions newest-first and they are inserted as fetched, so `date` correlates well but not perfectly. |
| `corp_wallet_journal` | `(corporation_id, date desc)` | `date` | Same shape. Already range-paged by `/structure/revenue`, which is the one query here known to page past PostgREST's row cap. |
| `corp_wallet_transaction` | `(registration_id, date desc)` | `date` | Same shape. |

### Group B — the SCD-2 histories: possible, but each needs its own answer

Every `*_over_time` table carries three index shapes:

1. `(<owner>_id)` — a bare btree over a **very low cardinality** column (one
   value per registration or corporation). 18 of these exist. On a large table
   this is the classic BRIN candidate *if* rows for one owner land contiguously
   — which they do, because the per-character fan-out runs one character per
   step, so a run appends that character's rows in a block. Worth measuring.
2. `(<entity>_id, valid_until desc)` — high-cardinality equality on the leading
   column. **Leave as btree.**
3. `... where is_current` partial uniques — these only index the *current*
   rows, so they are already small and are the identity constraint besides.
   **Leave alone.**

Tables in this group: `character_asset_over_time`, `character_blueprint_over_time`,
`character_order_over_time`, `character_industry_job_over_time`,
`character_clone_over_time`, `character_skill_over_time`,
`character_ship_over_time`, `character_fitting_over_time`,
`character_mercenary_den_over_time`, and the `corp_*` mirrors
(`corp_asset_over_time`, `corp_blueprint_over_time`, `corp_industry_job_over_time`).

### Group C — explicitly out of scope

`universe_name`, `universe_structure`, `esi_etag`, `sde_*`, `sheet_csv`,
`esf_data`: bounded by the size of New Eden or by one row per key, not by time.
Contract tables (`character_contract`, `corp_contract`) upsert in place and are
bounded by contracts seen. `registration`, `token`, `user_settings` and friends
are bounded by account count.

## Phases

### Phase 1 — measure, and possibly stop

Nothing below is worth doing on a table with 50k rows. **This phase may
legitimately conclude that `market_price_over_time` was the only table big
enough to care about**, and that is a fine outcome to write down and close.

Against production (read-only):

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

-- Is the candidate column actually correlated with physical order?
-- Below ~0.9 and BRIN is not worth trying.
select tablename, attname, correlation, n_distinct
from pg_stats
where schemaname = 'public'
  and attname in ('ran_at','ended_at','recorded_at','date','observed_at',
                  'valid_from','registration_id','corporation_id')
order by tablename, attname;

-- Which indexes is nobody using? A never-scanned index is a pure write tax,
-- and dropping it beats converting it.
select relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where schemaname = 'public'
order by pg_relation_size(indexrelid) desc
limit 30;
```

The third query matters as much as the other two. The market-prices work found a
60 MB btree the planner **never chose** — for that index the right change was not
"convert to BRIN" but "this should not exist". Expect more of those.

Gate to Phase 2: a table is a candidate only if it is **> ~1 GB**, its column
correlation is **> 0.9**, and the index in question is **either large and
unused, or large and serving range scans**.

### Phase 2 — one table, end to end, as the template

Take the single best candidate from Phase 1 (`heartbeat` is the likely winner:
purely append-only, never updated, and `latest_heartbeats()` is a known query).
For it:

1. Write down the queries that touch the index, from the calling code, not from
   imagination.
2. Restore a production-shaped copy locally and measure `EXPLAIN (ANALYZE,
   BUFFERS)` for each, before and after, at real row counts. The market-prices
   method — build both variants side by side in one database and compare
   `pg_total_relation_size` plus plans — is in
   [docs/market-prices/README.md](../market-prices/README.md).
3. Only then write the migration. `create index concurrently` for anything on a
   live table; the migration runner applies on push to `main`, so a long index
   build blocks deploys.
4. Record the measured numbers in the migration comment, the way the
   market-price migration does. A future reader must be able to tell whether the
   choice was reasoned or copied.

### Phase 3 — roll out to whatever else Phase 1 justified

One PR per table. Do not batch: each conversion changes query plans, and a
regression is much easier to attribute when it arrives alone.

### Phase 4 — the adjacent finding, if it survives Phase 1

The market-prices churn simulation measured 267k live rows occupying 143 MB —
the excess being dead tuples from the hourly `valid_until` touch, not row width.
**Every SCD-2 table here does that same touch on every run.** If Phase 1 shows
the big tables are mostly bloat rather than data, the higher-value project is
not indexes at all; it is revisiting the touch, or `fillfactor`, or autovacuum
settings (no table in `schema.sql` sets a `fillfactor` today). Worth a doc of its
own if the numbers point that way.

## Risks and non-goals

- **BRIN degrades silently.** It has no health metric a dashboard would show:
  correlation drops, queries get slower, nothing errors. Any table converted
  should have its `pg_stats.correlation` re-checked periodically — worth folding
  into whatever Phase 1 tooling gets written.
- **Summarisation lags inserts.** New heap blocks are not summarised until
  autovacuum runs or `brin_summarize_new_values()` is called, so freshly
  inserted rows fall back to a scan. Harmless for history queries, bad for
  anything reading the newest rows through the BRIN.
- **Not a substitute for retention.** BRIN shrinks the *index*. If a table is
  large because it keeps everything forever, the honest fix is a retention
  policy; BRIN just makes the table cheaper to keep.
- **Non-goal: converting anything on read-path latency grounds.** Every
  conversion here trades a little query time for a lot of space. If a table is
  small enough that its indexes do not matter, leave it alone.
