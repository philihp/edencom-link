-- Hourly market price capture from appraise.gnf.lt, as SCD Type 2 history.
--
-- The industry spreadsheet used to pull https://appraise.gnf.lt/market/<m>/prices.json
-- straight from an Apps Script UrlFetchApp on every recalculation, which meant
-- the sheet only ever saw "now" — yesterday's prices were unrecoverable. The
-- market-prices job (src/jobs/marketPrices.js) now captures the feed hourly and
-- versions it here, and /sheets/market/<market> serves it back as the same
-- TypeID/Updated/Buy/Sell CSV the script produced, with an optional `at` for
-- time travel. See docs/market-prices/README.md.
--
-- Versioning only the best bid, best ask and pricing strategy is deliberate:
-- the feed's volume/order_count/avg fields and its per-type `updated` stamp
-- churn hourly for essentially every type, so including them would open ~20k
-- rows per market per hour and turn this into an append-only firehose. What is
-- kept compresses hard, because a price that nobody moved writes nothing.
--
-- This table is expected to be the largest in the database, so its physical
-- shape was measured rather than assumed (docs/market-prices/README.md
-- "Storage"). Three choices come out of that and are load-bearing:
--
--   1. No surrogate id. A bigint key plus its btree costs ~30 bytes a row —
--      19% of the table — purely to address rows the reconcile can already
--      address: among is_current rows, (market, type_id) is unique, and the
--      partial unique index below is both that identity and the reconcile's
--      read/write handle. Dropping it measured -23% total size.
--   2. Column order puts the 8-byte-aligned columns first, so no padding holes
--      open between them (-1.6%, free).
--   3. Text columns are NOT normalised into lookup tables. Measured: replacing
--      `market` with a smallint FK saved exactly zero bytes, because the freed
--      space becomes alignment padding ahead of the next bigint.
create table public.market_price_over_time (
  type_id bigint not null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  -- Best bid / best ask, null when that side of the book is empty (which is
  -- distinct from a real price of zero). Variable-width, so they follow the
  -- fixed-width columns above.
  buy_max numeric,
  sell_min numeric,
  -- The service's own market id ('C-J6MT', 'jita', …), not an EVE region or
  -- structure id: these are appraisal presets, some of which span several
  -- stations. Text for that reason.
  market text not null,
  -- How the service derived the price: 'orders' (that market's own book),
  -- 'orders_universe' (widened to New Eden), or 'ccp' (CCP's adjusted price,
  -- i.e. no live orders at all). Versioned because it is stable and changes
  -- how the number should be read.
  strategy text,
  is_current boolean not null default true
);

-- The one index the hot paths need, doing three jobs at once: it is the row
-- identity (one open row per market/type — the invariant the reconcile closes
-- before inserting to preserve), the handle the reconcile pages and updates
-- through, and the index that answers a live snapshot (market = X and
-- is_current) as an index-only scan.
create unique index market_price_over_time_current_idx
  on public.market_price_over_time (market, type_id) where is_current;

-- Point-in-time reconstruction. BRIN, not btree: every run appends its changed
-- rows at the end of the heap, so valid_from is near-perfectly correlated with
-- physical position — exactly the shape BRIN summarises well. Measured at 2M
-- rows the btree equivalent was 60 MB against BRIN's 40 kB, for ~2.5 ms extra
-- on a deep-history query (2.6 ms → 5.1 ms). market is deliberately not in the
-- index: rows from both markets interleave within a block, so summarising it
-- would match every range; it is filtered on the recheck instead.
create index market_price_over_time_asof_idx
  on public.market_price_over_time using brin (valid_from) with (pages_per_range = 32);

-- Current-snapshot view, matching the *_over_time / like-named-view pairing
-- every other SCD-2 table here uses.
create view public.market_price as
  select type_id, valid_from, valid_until, buy_max, sell_min, market, strategy
  from public.market_price_over_time
  where is_current;

-- Third-party public market data, no player data in it, identical for every
-- caller — so it is world-readable like the sde_* mirror and sheet_csv rather
-- than RLS-scoped to auth.uid(). Writes stay service-role (the cron).
alter table public.market_price_over_time enable row level security;
create policy "Everyone reads market prices" on public.market_price_over_time
  for select to anon, authenticated using (true);
grant select on public.market_price_over_time to anon, authenticated;
grant select on public.market_price                to anon, authenticated;
grant all    on public.market_price_over_time to service_role;

-- One market's prices, as a single json array — the same shape (and the same
-- reason) as character_orders(): 20k+ rows would otherwise be truncated by
-- PostgREST's max-rows cap, and building it here keeps the column order the
-- sheet's headers are derived from.
--
-- as_of null means live, and that is not merely a default: the two cases get
-- separate branches because they need separate plans. A live snapshot is
-- exactly the is_current rows, which the partial unique index answers as an
-- index-only scan; folding it into the time-travel predicate instead
-- (valid_from <= as_of and (is_current or valid_until >= as_of)) makes the OR
-- unindexable and forces a sequential scan of the whole table — measured 4.5 ms
-- against 97 ms at 2M rows, and the gap widens with every row added. The row
-- projection is repeated rather than shared for that reason; keep the two in
-- step.
--
-- SECURITY INVOKER, like every other function here; safe because the table is
-- world-readable by design.
create or replace function public.market_price_snapshot(market_id text, as_of timestamptz default null)
returns json
language plpgsql
stable
as $$
declare
  result json;
begin
  if as_of is null then
    select coalesce(
      json_agg(
        json_build_object(
          'type_id',  p.type_id,
          'buy_max',  p.buy_max,
          'sell_min', p.sell_min,
          'strategy', p.strategy,
          -- When this price took effect (how long it has stood unchanged) and
          -- when a run last confirmed it still stands.
          'since',    p.valid_from,
          'updated',  p.valid_until
        )
        order by p.type_id
      ),
      '[]'::json
    )
    into result
    from public.market_price_over_time p
    where p.market = market_id
      and p.is_current;
  else
    select coalesce(
      json_agg(
        json_build_object(
          'type_id',  p.type_id,
          'buy_max',  p.buy_max,
          'sell_min', p.sell_min,
          'strategy', p.strategy,
          'since',    p.valid_from,
          'updated',  p.valid_until
        )
        order by p.type_id
      ),
      '[]'::json
    )
    into result
    from public.market_price_over_time p
    where p.market = market_id
      and p.valid_from <= as_of
      and (p.is_current or p.valid_until >= as_of);
  end if;
  return result;
end;
$$;

grant execute on function public.market_price_snapshot(text, timestamptz) to anon, authenticated, service_role;
