-- SQL-level coverage for market_price_at(): the per-(type, moment) price
-- lookup /industry prices each job's bill with at its install moment.
--
-- Run against a THROWAWAY database from the repo root:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

-- Stand-in: the columns the function reads, in the real table's shape.
create table public.market_price_over_time (
  type_id bigint not null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  buy_max numeric,
  sell_min numeric,
  market text not null,
  is_current boolean not null default true
);

-- Tritanium in Jita: three contiguous versions, the last one current.
insert into public.market_price_over_time (type_id, market, valid_from, valid_until, buy_max, sell_min, is_current) values
  (34, 'jita', '2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 4.0, 4.2, false),
  (34, 'jita', '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z', 5.0, 5.2, false),
  (34, 'jita', '2026-09-20T00:00:00Z', '2026-10-01T00:00:00Z', 6.0, 6.2, true),
  -- The same type in another market must never answer a Jita probe.
  (34, 'C-J6MT', '2026-08-01T00:00:00Z', '2026-10-01T00:00:00Z', 9.0, 9.9, true),
  -- A one-sided book: nothing bid.
  (35, 'jita', '2026-09-05T00:00:00Z', '2026-10-01T00:00:00Z', null, 12.5, true);

\i supabase/migrations/20261005000605_market_price_at.sql

do $$
declare
  answer json;
  row json;
begin
  answer := public.market_price_at('jita', '[
    {"type_id": 34, "as_of": "2026-09-15T12:00:00Z"},
    {"type_id": 34, "as_of": "2026-09-10T00:00:00Z"},
    {"type_id": 34, "as_of": "2026-09-25T00:00:00Z"},
    {"type_id": 34, "as_of": "2026-08-01T00:00:00Z"},
    {"type_id": 35, "as_of": "2026-09-30T00:00:00Z"},
    {"type_id": 36, "as_of": "2026-09-30T00:00:00Z"}
  ]'::jsonb);

  -- One answer per probe that has any version at all; the unknown type (36)
  -- is simply absent, never a null-priced row.
  if json_array_length(answer) <> 5 then
    raise exception 'expected 5 answers, got %: %', json_array_length(answer), answer;
  end if;

  -- Mid-version: the version whose valid_from is the latest at or before.
  row := answer -> 1; -- ordered by (type_id, as_of): 34 @ 09-10, 34 @ 09-15, 34 @ 09-25 come after 34 @ 08-01
  if (row ->> 'as_of')::timestamptz <> '2026-09-10T00:00:00Z' or (row ->> 'buy_max')::numeric <> 5.0 or (row ->> 'exact')::boolean is not true then
    raise exception 'a probe exactly on a version boundary takes the version that starts there: %', row;
  end if;
  row := answer -> 2;
  if (row ->> 'buy_max')::numeric <> 5.0 or (row ->> 'sell_min')::numeric <> 5.2 or (row ->> 'exact')::boolean is not true then
    raise exception 'a mid-version probe takes the version in effect: %', row;
  end if;
  row := answer -> 3;
  if (row ->> 'buy_max')::numeric <> 6.0 or (row ->> 'exact')::boolean is not true then
    raise exception 'a probe inside the current version takes it: %', row;
  end if;

  -- Before the capture began: the earliest version, flagged inexact — and the
  -- other market's older, cheaper row never leaks in.
  row := answer -> 0;
  if (row ->> 'as_of')::timestamptz <> '2026-08-01T00:00:00Z' or (row ->> 'buy_max')::numeric <> 4.0 or (row ->> 'exact')::boolean is not false then
    raise exception 'a probe before the capture falls back to the earliest version, inexact: %', row;
  end if;
  if (row ->> 'since')::timestamptz <> '2026-09-01T00:00:00Z' then
    raise exception 'since reports the version''s own valid_from: %', row;
  end if;

  -- A one-sided book keeps its null side null (distinct from zero).
  row := answer -> 4;
  if (row ->> 'type_id')::bigint <> 35 or row -> 'buy_max' is null or (row ->> 'buy_max') is not null or (row ->> 'sell_min')::numeric <> 12.5 then
    raise exception 'a one-sided book keeps its empty side null: %', row;
  end if;

  -- Nothing to ask is an empty array, not null.
  if public.market_price_at('jita', '[]'::jsonb)::text <> '[]' then
    raise exception 'no probes answers an empty array';
  end if;

  raise notice 'market_price_at: all assertions passed';
end $$;

rollback;
