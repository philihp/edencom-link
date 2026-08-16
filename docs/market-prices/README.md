# Market prices: hourly capture from appraise.gnf.lt, served as CSV

## What this is

The industry spreadsheet priced items with an Apps Script that fetched the GNF
appraisal service on every recalculation:

```js
function getMarketPrices(market) {
  var response = UrlFetchApp.fetch("https://appraise.gnf.lt/market/" + market + "/prices.json"),
  // … reshapes the JSON into [TypeID, Updated, Buy, Sell] rows, sorted by TypeID
}
```

It worked, but the sheet only ever saw **now**. Nothing kept yesterday's
prices, so "what was this worth when we built it" was unanswerable, and every
recalculation re-fetched 11 MB from someone else's server.

This captures the same feed hourly into an SCD Type 2 table and serves it back
as the same CSV — with an `at` parameter, so the sheet can ask for a past
moment.

## Endpoints (the deliverable)

`https://edencom.link/sheets/market/<market>` — public, no `api_token`, same
reasoning as `/sheets/[file]` (third-party data about the public market,
nothing about the caller's account, identical bytes for everyone). A trailing
`.csv` is accepted and ignored, because sheet URLs read better with it.

| Column | Meaning |
|---|---|
| `TypeID` | EVE type id, ascending — same order the Apps Script sorted into |
| `Updated` | when a run last confirmed this price still stands |
| `Buy` | best bid, empty when nothing is bid |
| `Sell` | best ask, empty when nothing is offered |
| `Since` | when this price took effect (how long it has stood unchanged) |
| `Strategy` | how the service derived it — see below |

The first four columns are exactly what `getMarketPrices` returned, in the same
order, so pointing a tab here is a drop-in swap. `Since` and `Strategy` are
appended rather than inserted, so existing formulas keep their column letters.

Tracked markets are `C-J6MT` and `jita` (`TRACKED_MARKETS` in
`src/gnfMarket.js`); the service offers nine more, listed there as
`KNOWN_MARKETS`. An untracked market 404s rather than answering an empty CSV
that would read as "this market has no prices".

```
=IMPORTDATA("https://edencom.link/sheets/market/C-J6MT.csv")
=IMPORTDATA("https://edencom.link/sheets/market/jita.csv?at=2026-06-01")
```

`at` takes the same partial-ISO grammar as the Sheets API endpoints
(`src/utils/atParam.ts`): `2026`, `2026-06`, `2026-06-01T18`, or a full
timestamp. Absent means live.

### `Strategy`

How the service arrived at the number, carried through because it changes how
the price should be read:

- `orders` — that market's own order book
- `orders_universe` — widened to New Eden, because the local book was thin
- `ccp` — no live orders at all, just CCP's adjusted price

In a sample of C-J6MT, 2,839 of 20,536 types were `ccp`, i.e. not really
priced by anyone. A sheet that treats those as market prices is pricing off
CCP's index, and now it can tell.

## Data flow

```
appraise.gnf.lt ──(market-prices workflow, hourly at :03)──▶ market_price_over_time
                                                                      │
                                                    market_price_snapshot(market, as_of)
                                                                      ▼
        Google Sheets =IMPORTDATA("https://…/sheets/market/C-J6MT.csv")
                                                                      ▲
                                        /sheets/market/[market] route
```

## What is versioned, and why so little

The SCD Type 2 shape only pays off if most hours write nothing. The feed makes
that a real design constraint: it re-derives **every** type hourly, so 20,049
of 20,536 entries carried an `updated` stamp less than an hour old in the
sample. Versioning on anything that moves with the clock rather than with the
market would open ~20k rows per market per hour — append-only in all but name,
and 175M rows a year for a table meant to compress.

So the version signature is exactly three fields (`signature()` in
`src/jobs/marketPriceReconcile.js`):

| Field | Kept? | Why |
|---|---|---|
| `buy.max` → `buy_max` | **versioned** | the best bid, what the sheet prices against |
| `sell.min` → `sell_min` | **versioned** | the best ask, likewise |
| `strategy` | **versioned** | stable, low-cardinality, changes how to read the number |
| `updated` | dropped | changes hourly for ~every type; `valid_until` answers the same question about *our* data more accurately |
| `volume`, `order_count` | dropped | jitter every hour; depth, not price |
| `avg`, `median`, `percentile`, `stddev`, `min`/`max` on the far side, the whole `all` group | dropped | derived stats that move constantly |

An empty order book stores `null`, never `0` — "nobody is bidding" and
"somebody is bidding zero" are different facts, and 7,143 of 20,536 types had
no bid at all in the sample.

Prices are rounded to two decimals, which is EVE's own precision. That isn't
about storage: it stops IEEE 754 drift (`0.1 + 0.2` is `0.30000000000000004`)
from opening a new version for a price nobody moved.

## Storage

This is expected to become the largest table in the database, so its physical
shape was measured rather than reasoned about: four candidate layouts, 2M rows
each, real Postgres 16, comparing `pg_total_relation_size`.

| Layout | Bytes/row | vs. baseline |
|---|---|---|
| Baseline: surrogate `id`, btree as-of index, text columns | 158.2 | — |
| `market` normalised to a `smallint` FK | 158.2 | **0.0%** |
| `market` *and* `strategy` normalised | 150.9 | −4.6% |
| Columns reordered, text kept | 155.7 | −1.6% |
| No surrogate `id` | 121.5 | −23% |
| No `id` + BRIN as-of index | 90.0 | **−43%** |

The counter-intuitive row is the second one. **Normalising `market` into a
lookup table saves exactly zero bytes.** `'C-J6MT'` is a 7-byte short varlena;
replacing it with a 2-byte `smallint` frees 5 bytes that immediately become
alignment padding ahead of the next `bigint`. The join, the FK, and the extra
table would buy nothing. (`strategy` is a slightly better candidate —
`'orders_universe'` is 16 bytes on 54% of rows — but 4.6% doesn't pay for a
lookup table either.)

What does pay:

- **No surrogate key (−23%).** A `bigint id` plus its btree costs ~30 bytes a
  row, ~19% of the table, purely to address rows. It isn't needed: among a
  market's `is_current` rows `(market, type_id)` is unique, which the partial
  unique index already enforces, so the reconcile addresses rows with
  `market = ? and is_current and type_id in (?)`. The `is_current` filter is
  what makes it exact — without it the same type ids match every closed version
  in that market's history.
- **BRIN for the as-of index (−20% more).** Every run appends its changed rows
  at the end of the heap, so `valid_from` is near-perfectly correlated with
  physical position — the one condition BRIN needs. At 2M rows the btree was
  60 MB against BRIN's 40 kB, costing ~2.5 ms on a deep-history query (2.6 ms →
  5.1 ms). `market` is deliberately *not* in the BRIN: rows from both markets
  interleave within a block, so summarising it would match every range; it is
  filtered on the recheck instead.
- **Column order (−1.6%, free).** Fixed-width 8-byte columns first, so no
  padding holes open between them.

At the measured 90 bytes/row: ~3.2 GB/year at 10% hourly churn, ~6.5 GB at 20%
— against 5.7/11.4 GB for the naive layout.

### The live query is the one that had to be fixed

Storage was the smaller problem. The snapshot predicate
`valid_from <= as_of and (is_current or valid_until >= as_of)` cannot use any
index because of the OR, so *every sheet refresh* was a sequential scan of the
whole table — 97 ms at 2M rows, and linear in table size from there.

At `as_of = now()` that predicate is just "the current rows" anyway (a closed
row's `valid_until` is stamped at close time, so it can only satisfy
`valid_until >= now()` within the same instant). So `market_price_snapshot`
takes `as_of` defaulting to **null**, meaning live, and branches: the live
branch is `market = ? and is_current`, answered by the partial unique index as
an index-only scan in **4.5 ms** instead of 97 — and, unlike the scan, it stays
flat as the table grows. The route passes null whenever `at=` is absent rather
than resolving it to `now()`.

The row projection is duplicated across the function's two branches on purpose:
sharing it means one predicate, and one predicate means the slow plan for both.

### Update bloat, not row width, may end up dominating

Measured over 60 simulated hourly cycles at 20% churn (the job's real
touch/close/insert statements): 267k live rows occupied **143 MB**, against
~24 MB of actual row data. The difference is dead tuples from the hourly touch —
every run rewrites ~20k rows to bump `valid_until`, and each rewrite leaves a
dead version behind. Autovacuum reclaims the space for reuse so this reaches a
steady state rather than growing without bound, but the steady state is several
times the live-row arithmetic above.

The same run answered the question that prompted the BRIN choice: does closing
rows (an `is_current` flip, which cannot be a HOT update, so the tuple moves)
scatter old `valid_from` values into new blocks and degrade the index?
Measured correlation of `valid_from` with physical order after those 60 cycles:
**0.9996**. It does not. A row that changes often was opened recently, so its
moved tuple carries a recent `valid_from`; a row that never changes never moves.
The BRIN stayed at 32 kB and a deep-history query at 8 ms.

If bloat does become the binding constraint, the lever is the touch itself: it
exists only to keep the CSV's `Updated` column truthful. Recording one
"confirmed at" row per (market, run) in a tiny side table and joining it in
would remove ~20k UPDATEs an hour outright. Not done here — it changes what
`valid_until` means on this table, and the churn should be measured on real data
first.

### Measuring the real churn

Still unknown until it has run for a day — the numbers above scale whatever it
turns out to be:

```sql
select market,
       count(*) filter (where is_current)      as open_rows,
       count(*) filter (where not is_current)  as closed_rows,
       count(*) filter (where valid_from > now() - interval '1 hour') as opened_last_hour
from market_price_over_time group by market;
```

Retention is **keep everything**. If the rate turns out uncomfortable, a sweep
of closed rows past some age is additive — no schema change, no effect on the
current snapshot, and the tail of history is the cheap part to lose.

## Pieces

| | |
|---|---|
| `src/gnfMarket.js` | the only module that talks to appraise.gnf.lt; `TRACKED_MARKETS`, `fetchMarketPrices`, and the truncated-feed floor |
| `src/jobs/marketPriceReconcile.js` | pure seam: `normalizePrices`, `signature`, `partitionPrices`. Tested in `test/marketPriceReconcile.test.ts` |
| `src/jobs/marketPrices.js` | the job — paged current-row read, reconcile, batched touch/close/insert. `pnpm run market-prices` |
| `src/workflows/marketPrices.ts` | one step per market, heartbeat opened and closed by their own steps |
| `src/app/api/cron/market-prices/route.ts` | hourly Vercel Cron trigger (`3 * * * *`) |
| `src/app/sheets/market/[market]/route.ts` | the public CSV |
| `market_price_over_time` + `market_price` + `market_price_snapshot()` | `supabase/migrations/20260816040000_market_price.sql`, mirrored into `schema.sql`. No surrogate key; one partial unique index doing identity, paging and the live query; BRIN for time travel |

## Decisions taken (revisit if wrong)

1. **`Updated` is our confirmation time, not the feed's `updated`.** Keeping
   the feed's per-type stamp verbatim would mean either versioning on it (the
   firehose above) or refreshing it in place per row — 20k individual updates
   an hour, since every row carries a different microsecond. `valid_until` is
   one batched update and answers the question the column is actually used
   for: how stale is this number.
2. **A truncated feed fails the run rather than reconciling.** The feed is a
   complete listing, so absence means delisting — which makes a half-delivered
   response look like a mass delisting and close thousands of rows. Anything
   under 10,000 types (`MIN_PLAUSIBLE_TYPES`) is refused before a row is
   touched.
3. **One step per market**, not one step for the run. ~11 MB fetched and 20k+
   rows reconciled per market is comfortable alone and not stacked, and a
   market the service is having trouble with shouldn't cost the others their
   hour.
4. **Markets run sequentially inside the run.** Two concurrent 11 MB pulls buy
   nothing but a heavier hand on someone else's bandwidth.
5. **World-readable table**, like `industry_system_index` and the `sde_*`
   mirror — public data about the game world, not player data, so no RLS
   scoping to `auth.uid()`.
6. **Historical `at` responses are cached hard** (`immutable`), live ones
   briefly. A moment that has already passed can't gain or lose rows: a later
   run only writes versions with a newer `valid_from`, and closing a row leaves
   its `valid_until` past the asked-for instant.
7. **No surrogate key, BRIN as-of index, live/time-travel branches** — all three
   measured, see Storage above. The first two are why the table is 43% smaller
   than the obvious layout; the third is why a sheet refresh is 20× faster and
   stops degrading as history accumulates.

## Open questions

1. Should the other nine markets gnf.lt offers be tracked? Adding one is a
   one-line change to `TRACKED_MARKETS`, and it costs a step and its share of
   the churn above.
2. `list_market_orders` (MCP) reads the player's *own* orders. Nothing yet
   exposes these captured prices to MCP or to the app's own pages — an
   `appraise_items` that priced against a chosen market and moment would be the
   obvious next use of this table.
