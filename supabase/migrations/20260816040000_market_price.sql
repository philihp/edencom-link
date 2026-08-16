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

create table public.market_price_over_time (
  id bigint generated always as identity primary key,
  -- The service's own market id ('C-J6MT', 'jita', …), not an EVE region or
  -- structure id: these are appraisal presets, some of which span several
  -- stations. Text for that reason.
  market text not null,
  type_id bigint not null,
  -- Best bid / best ask, null when that side of the book is empty (which is
  -- distinct from a real price of zero).
  buy_max numeric,
  sell_min numeric,
  -- How the service derived the price: 'orders' (that market's own book),
  -- 'orders_universe' (widened to New Eden), or 'ccp' (CCP's adjusted price,
  -- i.e. no live orders at all). Versioned because it is stable and changes
  -- how the number should be read.
  strategy text,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);

-- The reconcile's hot path: every open row for one market, paged by id.
create index market_price_over_time_market_current_idx
  on public.market_price_over_time (market, id) where is_current;
-- One open row per (market, type) — the invariant the reconcile closes before
-- inserting to preserve.
create unique index market_price_over_time_current_idx
  on public.market_price_over_time (market, type_id) where is_current;
-- Point-in-time reconstruction: market_price_snapshot() seeks by market and
-- validity window.
create index market_price_over_time_asof_idx
  on public.market_price_over_time (market, valid_from desc);

-- Current-snapshot view, matching the *_over_time / like-named-view pairing
-- every other SCD-2 table here uses.
create view public.market_price as
  select id, market, type_id, buy_max, sell_min, strategy, valid_from, valid_until
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

-- One market's prices as of a moment, as a single json array — the same shape
-- (and the same reason) as character_orders(): 20k+ rows would otherwise be
-- truncated by PostgREST's max-rows cap, and building it here keeps the
-- column order the sheet's headers are derived from.
--
-- SECURITY INVOKER, like every other function here; safe because the table is
-- world-readable by design.
create or replace function public.market_price_snapshot(market_id text, as_of timestamptz default now())
returns json
language sql
stable
as $$
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
  from public.market_price_over_time p
  where p.market = market_id
    and p.valid_from <= as_of
    and (p.is_current or p.valid_until >= as_of);
$$;

grant execute on function public.market_price_snapshot(text, timestamptz) to anon, authenticated, service_role;
