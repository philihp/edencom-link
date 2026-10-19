# Plan: what an item sold for over the last 90 days

Status: 📋 plan only, written 2026-10-19. Nothing is built. The owner picks an
option (see "Decisions") before any PR below starts.

The fit-upgrade procedure in [the skill document](../edencom-industry-SKILL.md)
("Upgrading a ship's fit", step 3) defines a good price as a percentage below
what the item **sold for over the last 90 days**. No table, tool or third-party
call in this deployment answers that today, so the skill falls back on the
current Jita split and ten days of closed public contracts. This plan picks a
source for the real figure and puts it where an agent will read it: beside the
prices `appraise_items` already returns.

## What the stack holds today (measured 2026-10-19)

| Source | What it is | Why it is not the answer |
| :-- | :-- | :-- |
| `market_price_over_time` | Hourly best bid and best ask for `jita` and `C-J6MT` ([market-prices/](../market-prices/README.md)) | Listed prices, not trades, and no volume. Capture began 2026-08-16 (first Damage Control II row, both markets), so a 90-day window exists only from 2026-11-14 |
| `public_contract*` | Every public contract, open and closed ([public-contracts.md](../public-contracts.md)) | Starts 2026-10-09. A closed contract is `gone` (accepted **or withdrawn**) or `expired`, so a closure is not a sale |
| innomin.at `sell_average` / `buy_average` | Returned by every appraisal, dropped by `src/innominate.ts` | The provider's OpenAPI schema calls them "Historical sell/buy average" and names no window, so they cannot be called 90-day figures |
| `character_wallet_transaction` | The user's own trades (`search_transactions`) | What the user paid, not what the market paid |

## Where sales history comes from

**ESI `GET /markets/{region_id}/history/?type_id=`**, public, no token. Read
by hand on 2026-10-19 for Damage Control II (2048):

- One call returns the **whole retained history**: 412 days, 2025-09-01 to
  2026-10-17. Each day is `{ date, average, highest, lowest, volume,
  order_count }`, where `average` is that day's volume-weighted trade price.
- The cache expires daily at **11:05 UTC** (`expires` header), when the
  previous day lands.
- It is per **region** and per **type**, one call each. EVE Ref's scraper
  documentation gives the endpoint's limit as **300 requests a minute**.
- How many pairs: `/markets/{region_id}/types/` (types with an open order)
  answered **20 pages** for The Forge and **8** for Insmother — about 19,500
  and 7,500 types.

**Region history includes player-structure markets.** C-J6MT is in
**Insmother** (10000009). Insmother's Damage Control II history shows 225–377
orders and 268–500 units a day at ~404k ISK, close to the C-J6MT market's own
prices; no NPC station in that region trades on that scale. So Insmother's
history is, in practice, the C-J6MT market — with the caveat that any other
Insmother market is folded in.

**EVE Ref's market-history dumps** (`https://data.everef.net/market-history/`)
are that same endpoint, scraped for every region and published as one file a
day, `market-history-YYYY-MM-DD.csv.bz2`, ~550–650 KB compressed. `totals.json`
counts ~45,000–55,000 region/type rows a day (averaging ~50,000 over the 88
complete days to 2026-10-15); its counts start at 2022-02-22, though the
directory has year folders back to 2003. A day's file fills
in over the following one or two days (2026-10-16 held 9,975 rows and
2026-10-17 held 3 when read), and past files are rewritten in place. The
scraper chooses which pairs to ask for by heuristics (recent history, active
orders, top traded, a rotating explorer bucket), so a rarely traded pair can be
missing.

## Options

### A. ESI directly, one summary row per item (recommended)

A daily extract job asks ESI for each pair's history and keeps only the folded
figures, not the days.

- **Calls:** ~27,000 pairs refreshed once a week, oldest first, is ~3,900 calls
  a day — about 13 minutes at 5 a second. The deployment already sends more
  unauthenticated ESI traffic than that: `public-contracts` may fetch up to 1,000
  contracts' items every 15 minutes. A one-time backfill of all pairs is ~90
  minutes, or the weekly rotation simply reaches full coverage on day 7.
- **Storage:** one row per region and type, ~27,000 rows, a few MB.
- **Freshness:** at most 7 days old. A 90-day average moves little in a week.
- **Fit with the codebase:** ESI → extract job → table → tool, the house data
  flow. No new dependency. Reuses `shouldStandDown` for the error limit.
- **Risk:** unauthenticated calls from Vercel's shared egress. The first runs
  must log the `X-Ratelimit-*` and error-limit headers, and stand down early.

### B. EVE Ref's daily files, one row per item per day

A daily job downloads the last few days' files (to pick up the in-place
updates), keeps the rows for the tracked regions, and drops days older than
the window. A view or materialized view folds them.

- **Calls:** one to three downloads a day, ~2 MB. Backfill: 90 files, ~54 MB,
  once.
- **Storage:** daily rows for two regions. Not measured yet; the upper bound,
  every pair trading every day, is ~27,000 × 91 ≈ 2.5 M rows, ~250 MB with the
  key index at ~100 bytes a row. Likely half that. The 2026-09-10 IO incident
  and the deferred 676 MB moons table are reasons to count this cost.
- **Fit:** a third-party source like `structure-directory` already uses. Needs
  `unbzip2-stream`, the dependency [public-contracts-archive.md](../public-contracts-archive.md)
  already chose, so the two plans share it.
- **Gains over A:** daily rows to chart; every region for little extra
  download cost; history back to 2022.

### C. Our own listed prices (zero ingest)

A time-weighted average of the hourly Jita/C-J6MT split from
`market_price_over_time`, computed at read time over the indexed per-type
history (`market_price_at()`'s btree).

- **Cost:** nothing new to fetch or store.
- **Available:** a full 90 days from 2026-11-14.
- **Weakness:** it is what sellers asked and buyers bid, not what traded, and it
  has no volume. Exact to the C-J6MT station market, though, where A and B see
  all of Insmother.

### D. innomin.at's averages

Pass `sell_average`/`buy_average` through `appraise_items`. Free if the
provider states the window and it is near 90 days. Worth one email whatever is
chosen; not something to build on until answered.

## Recommendation

**A**, refreshing the two regions the skill prices in (The Forge for `jita`,
Insmother for `cj6mt`). It answers the question the skill asks with official
data, costs a few MB, and fits the architecture without a new dependency. If
the owner later wants daily charts or every region, B is the better base and
the summary table can be fed from it instead.

## The figures

For each region and type, over the 90 days ending on the last day ESI reported
(`through`):

| Column | Meaning |
| :-- | :-- |
| `average_90d` | Σ(`average` × `volume`) ÷ Σ `volume` — what a unit sold for, weighted by how many sold each day |
| `low_90d`, `high_90d` | Lowest `lowest` and highest `highest` of the window |
| `volume_90d` | Units traded |
| `days_traded_90d` | Days with any trade. A thin market (a few days) makes `average_90d` weak, and the tool should say so |
| `average_30d`, `volume_30d` | The same over 30 days, to show a trend against the 90-day figure |
| `fetched_at` | When the job last read the pair; drives the refresh order |

A pair with no trade in the window still gets a row (zeros, null averages) so
the rotation knows it was checked.

## Build order

**PR 1 — the data.**

- `market_history_summary` table (migration from `pnpm run db:new`, and
  `schema.sql`): `primary key (region_id, type_id)`, the columns above.
  World-readable like `market_price_over_time` (public market data), written
  only by the service role. `test/sql/market_history_summary.sql` for the
  grants.
- `marketHistory(regionId, typeId)` and `marketTypes(regionId, page)` in
  `src/esi.js` (no token, `esiJsonTolerant` for a 404 on a never-traded pair).
- A pure fold, `summarizeHistory(days, windowDays, through)` in
  `src/jobs/marketHistoryFields.js`, tested: the weighted average, the
  window's edges, thin and empty histories.
- The job `market-history` (`src/jobs/marketHistory.js`): list each region's
  types, take the never-read ones first and then the oldest `fetched_at`, up
  to the day's quota (~4,000) or budget; pace at 4 calls a second; stand down
  on the error limit; upsert. Regions are a constant list mapped from the
  appraisal markets (`jita` → 10000002, `cj6mt` → 10000009).
- Workflow in `src/workflows/marketHistory.ts`, sliced into ~35-second steps
  the way the SDE mirror is; cron at 11:40 UTC, after ESI's 11:05 refresh;
  registry row on `/account/registrations`; heartbeat.
- Record the first runs: calls made, 420/429s seen, minutes taken.

**PR 2 — the answer.**

- `appraise_items` and `appraise_assets`: when the market is `jita` or
  `cj6mt`, each priced line gains
  `sold_90d: { average, low, high, volume, days_traded, average_30d, through }`,
  absent when the table has no row.
- The skill document: step 3 of "Upgrading a ship's fit" takes `sold_90d.average`
  as the reference and drops the fallback; the gas section can quote it beside
  the sell price.
- CLAUDE.md: the job, the table, the fields.

**PR 3 — optional.** GraphQL and Sheets columns; refresh first the types the
users hold or fit, so those are never a week old.

## Decisions

1. Which option: **A** (recommended), B, C as a stopgap until one of them
   lands, or D once innomin.at answers.
2. Which regions: The Forge and Insmother only, or every appraisal market
   (Amarr, Dodixie, Hek, Rens, UALX-3 too).
3. Refresh period for A: 7 days, or shorter for more ESI calls.
4. Whether to ask innomin.at what window its averages cover.

## Not in this plan

- Items that trade only by contract (Abyssal modules): their history is the
  public contracts we already keep, plus the EVE Ref contract archive in
  [public-contracts-archive.md](../public-contracts-archive.md).
- Charts of price history on the site.
