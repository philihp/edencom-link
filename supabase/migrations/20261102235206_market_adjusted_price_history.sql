-- CCP's adjusted prices become history (docs/item-pages.md "Adjusted-price
-- history"). /blueprint/[itemId] prices every run a blueprint made at the
-- adjusted price in effect when that run was installed — the price the game
-- itself used for the job's EIV — and that figure must never move afterwards.
-- A latest-only table cannot answer "at that moment", so market_adjusted_price
-- becomes the SCD-2 pair every other versioned table here uses: the
-- *_over_time table, and a like-named view of its current rows keeping the
-- old columns (recorded_at is the open version's valid_until, the last run
-- that saw the price), so every existing reader — /structure's EIV, the
-- rollup, /sheets/adjusted-prices, the hull-price page — keeps working
-- unchanged.
--
-- The daily job reconciles like market-prices does: an unchanged price bumps
-- valid_until, a moved one closes its row and opens the next, a type CCP
-- stopped publishing is closed with no replacement. Adjusted prices are a
-- smoothed daily average, so most types move a little every day: expect
-- ~15k rows a day, ~0.8 MB — a fraction of market_price_over_time's hourly
-- captures, and the cost of a run's EIV meaning what it meant.
create table public.market_adjusted_price_over_time (
  type_id bigint not null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  adjusted_price double precision not null,
  -- ESI omits average_price for ~13% of types; null means "not published",
  -- which is different from zero.
  average_price double precision,
  is_current boolean not null default true
);

-- Row identity and the reconcile's handle: one open row per type.
create unique index market_adjusted_price_over_time_current_idx
  on public.market_adjusted_price_over_time (type_id) where is_current;

-- Per-type history in order: the one probe market_adjusted_price_at() makes
-- per (type, moment).
create index market_adjusted_price_over_time_type_history_idx
  on public.market_adjusted_price_over_time (type_id, valid_from);

-- Every price the latest-only table held becomes its type's first version,
-- dated at its last sighting — the only clock the row carried. A probe before
-- that moment falls back to this version, flagged inexact.
insert into public.market_adjusted_price_over_time
  (type_id, valid_from, valid_until, adjusted_price, average_price, is_current)
select type_id, recorded_at, recorded_at, adjusted_price, average_price, true
from public.market_adjusted_price;

drop table public.market_adjusted_price;

create view public.market_adjusted_price as
  select type_id, adjusted_price, average_price, valid_from, valid_until as recorded_at
  from public.market_adjusted_price_over_time
  where is_current;

-- World-readable like the table was: game-wide public data with no player in
-- it. Writes stay service-role (the cron).
alter table public.market_adjusted_price_over_time enable row level security;
create policy "Everyone reads adjusted price history"
  on public.market_adjusted_price_over_time
  for select
  to anon, authenticated
  using (true);

grant select on public.market_adjusted_price_over_time to anon, authenticated;
grant all    on public.market_adjusted_price_over_time to service_role;
grant select on public.market_adjusted_price to anon, authenticated, service_role;

-- market_adjusted_price_at: the adjusted price of many (type, moment) pairs in
-- one call — market_price_at()'s shape over this table. Each probe takes the
-- version whose valid_from is the latest at or before its moment; a moment
-- before the capture began (the job started 2026-08-26, and a job on record
-- can be older) takes the EARLIEST version instead, with exact = false so the
-- caller can say so rather than present a guess as a reading. One index probe
-- per (type, moment) over market_adjusted_price_over_time_type_history_idx;
-- the LIMIT over the UNION ALL reads the fallback only when nothing came
-- before. json rather than setof so PostgREST's max_rows never truncates an
-- answer. SECURITY INVOKER; safe because the table is world-readable.
create or replace function public.market_adjusted_price_at(probes jsonb)
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'type_id',        q.type_id,
        'as_of',          q.as_of,
        'adjusted_price', p.adjusted_price,
        'since',          p.valid_from,
        'exact',          (p.valid_from <= q.as_of)
      )
      order by q.type_id, q.as_of
    ),
    '[]'::json
  )
  from (
    select distinct type_id, as_of
    from jsonb_to_recordset(probes) as x(type_id bigint, as_of timestamptz)
  ) q
  cross join lateral (
    (
      select v.adjusted_price, v.valid_from
      from public.market_adjusted_price_over_time v
      where v.type_id = q.type_id and v.valid_from <= q.as_of
      order by v.valid_from desc
      limit 1
    )
    union all
    (
      select v.adjusted_price, v.valid_from
      from public.market_adjusted_price_over_time v
      where v.type_id = q.type_id and v.valid_from > q.as_of
      order by v.valid_from asc
      limit 1
    )
    limit 1
  ) p;
$$;

grant execute on function public.market_adjusted_price_at(jsonb) to anon, authenticated, service_role;

-- A table became a view: tell PostgREST before the next request reaches it.
notify pgrst, 'reload schema';
