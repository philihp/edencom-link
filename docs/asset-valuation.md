# Asset valuation

The `/asset` landing page opens with a chart of what the user's assets are
worth, day by day, before the location table: the hangar, industry jobs in
progress, market orders, contracts in flight and wallets. Market has its ISK flow chart and
Industry its lift chart; this is the same idea for the hangar.

## What a day's value is

For one owner (a registration, or a corporation) and one UTC day:

- **Holdings** at the day's moment: the end of the day for a past day, the
  extract's run for today. For each item, its latest asset version that had
  begun by then, kept when it is still current, or not yet closed, or has a
  later version (it was still held, in another state). The last test covers
  the versions closed before 2026-10, whose `valid_until` is the last sighting
  rather than the close.
- **Price**: the Jita split (midpoint of best bid and best ask; one side when
  the book has one) from `market_price_over_time`, the version in effect at
  that moment. Never a later price: a type captured after the day is unpriced
  that day. This is the price `/industry` uses for lift.
- **Left out**: blueprints (SDE category 9). A copy has no market, and an
  original's market price says nothing about its research. Unpriced types are
  counted (`unpriced_types`, `unpriced_units`) but add nothing, so the value is
  a floor.
- A day that ends before the price record begins (Tritanium's first Jita
  capture) is skipped, never stored as zero, so the chart has no false crash.

- **Industry jobs** (manufacturing and reactions) installed and not yet
  delivered at the moment: `(1 − done) × inputs + done × output`, where `done`
  is the share of the job's duration passed. The inputs are the SDE bill at
  the blueprint's ME with the lift rounding (reactions ME 0), the output the
  product × runs, both at the same split. **No install fee**: it is spent. A
  job counts until its completed date (a delivered job's output is back in
  the hangar), once for the corporation when both extracts list it, and not at
  all when a line has no price (`unpriced_jobs`).
- **Market orders** open at the moment (character orders; a corp order is
  filed under the character that placed it): a sell order's units left at the
  split (not its asking price), a buy order's escrow.
- **Contracts** in flight, from the status history: the included items of an
  outstanding item exchange or auction we issued, at the split; the collateral
  of a courier we issued (outstanding or in progress), or one we accepted and
  carry for someone outside the account (an alt-to-alt haul counts once).
- **Wallet**: the last balance recorded by then; for a corporation, the sum
  of its divisions. Corp wallet history starts when that pull began.

## Where it is computed

`asset_value_day_compute(p_registration_id, p_corporation_id, p_from, p_to)`
in Postgres does the whole fold and upserts one `asset_value_day` row per day.
Service role only. Recompute, never increment: a re-run replaces the day.

- **Every asset run.** `character-assets` and `corp-assets` call it for today
  after their reconcile (`recordAssetValue` in `src/jobs/assetValues.js`).
  Best-effort: a failure is logged and the extract still succeeds. Today's row
  is overwritten by each run, so a past day keeps the value of its last run.
- **Backfill.** `pnpm run asset-values [--since YYYY-MM-DD]` values every
  owner from its first asset version (or `--since`) to today, a week of days
  per call. Run it once after this ships, and again after migration
  `20261126202934` (the jobs, orders, contracts and wallet parts), which
  leaves the earlier rows at zero for those parts.

## The page

`src/app/asset/page.tsx` reads the rows RLS lets the caller see (own
registrations, own corporations) for the longest window plus the carry
lookback (`valueRows.ts`). The pure fold `valuation.ts` sums the kept owners
per day, part by part (the hover card lists each part). An owner with no row on a day (a failed or late run) carries its last
value for up to three days, marked "carried" in the hover card; past that it
counts as gone. The chart (`valueChart.tsx`) uses the lift chart's marks and
classes. One owner filter (the one the location pages share) and the shared
window dropdown drive the chart; the owner filter drives the table too.
