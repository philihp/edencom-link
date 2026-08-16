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

Unknown until it has run for a day, and deliberately not guessed at in code.
The arithmetic: 2 markets × ~20.5k types = ~41k rows on the first run, then
`churn × 41k` rows an hour. At 10% hourly churn that's ~36M rows a year; at
20%, ~72M. Roughly 100 bytes a row plus three indexes.

Retention is currently **keep everything**. If the rate turns out
uncomfortable, a sweep of closed (`is_current = false`) rows past some age is
additive — no schema change, no effect on the current snapshot, and the tail
of history is the cheap part to lose.

Worth measuring after the first day:

```sql
select market,
       count(*) filter (where is_current)      as open_rows,
       count(*) filter (where not is_current)  as closed_rows,
       count(*) filter (where valid_from > now() - interval '1 hour') as opened_last_hour
from market_price_over_time group by market;
```

## Pieces

| | |
|---|---|
| `src/gnfMarket.js` | the only module that talks to appraise.gnf.lt; `TRACKED_MARKETS`, `fetchMarketPrices`, and the truncated-feed floor |
| `src/jobs/marketPriceReconcile.js` | pure seam: `normalizePrices`, `signature`, `partitionPrices`. Tested in `test/marketPriceReconcile.test.ts` |
| `src/jobs/marketPrices.js` | the job — paged current-row read, reconcile, batched touch/close/insert. `pnpm run market-prices` |
| `src/workflows/marketPrices.ts` | one step per market, heartbeat opened and closed by their own steps |
| `src/app/api/cron/market-prices/route.ts` | hourly Vercel Cron trigger (`3 * * * *`) |
| `src/app/sheets/market/[market]/route.ts` | the public CSV |
| `market_price_over_time` + `market_price` + `market_price_snapshot()` | `supabase/migrations/20260816040000_market_price.sql`, mirrored into `schema.sql` |

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

## Open questions

1. Should the other nine markets gnf.lt offers be tracked? Adding one is a
   one-line change to `TRACKED_MARKETS`, and it costs a step and its share of
   the churn above.
2. `list_market_orders` (MCP) reads the player's *own* orders. Nothing yet
   exposes these captured prices to MCP or to the app's own pages — an
   `appraise_items` that priced against a chosen market and moment would be the
   obvious next use of this table.
