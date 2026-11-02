-- SQL-level coverage for migration 20261102235206: the latest-only
-- market_adjusted_price table becomes SCD-2 history behind a like-named view,
-- and market_adjusted_price_at() answers the price of many (type, moment)
-- pairs — what /blueprint/[itemId] prices each run at, as of its install.
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

-- Stand-in for the table as it stood before the migration.
create table public.market_adjusted_price (
  type_id bigint primary key,
  adjusted_price double precision not null,
  average_price double precision,
  recorded_at timestamptz not null default now()
);
insert into public.market_adjusted_price (type_id, adjusted_price, average_price, recorded_at) values
  (34, 6.0, 6.1, '2026-09-20T00:00:00Z'),
  (35, 12.5, null, '2026-09-20T00:00:00Z');

\i supabase/migrations/20261102235206_market_adjusted_price_history.sql

-- Earlier versions of Tritanium, as the job would have left them.
insert into public.market_adjusted_price_over_time (type_id, valid_from, valid_until, adjusted_price, average_price, is_current) values
  (34, '2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 4.0, 4.1, false),
  (34, '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z', 5.0, 5.1, false);

do $$
declare
  answer json;
  row json;
  n int;
begin
  -- The seed: every old row is its type's open version, dated at its last sighting.
  select count(*) into n from public.market_adjusted_price_over_time where is_current;
  if n <> 2 then raise exception 'expected 2 open versions after the seed, got %', n; end if;
  select count(*) into n from public.market_adjusted_price_over_time
    where type_id = 34 and is_current and valid_from = '2026-09-20T00:00:00Z' and adjusted_price = 6.0;
  if n <> 1 then raise exception 'the seeded version is dated at recorded_at'; end if;

  -- The view keeps the old columns: one row per type, recorded_at = the open row's valid_until.
  select count(*) into n from public.market_adjusted_price;
  if n <> 2 then raise exception 'the view lists one row per type, got %', n; end if;
  select count(*) into n from public.market_adjusted_price where type_id = 35 and adjusted_price = 12.5 and average_price is null and recorded_at = '2026-09-20T00:00:00Z';
  if n <> 1 then raise exception 'the view carries adjusted_price, average_price and recorded_at'; end if;

  -- One open row per type.
  begin
    insert into public.market_adjusted_price_over_time (type_id, adjusted_price) values (34, 7.0);
    raise exception 'a second open row for a type must be refused';
  exception when unique_violation then null;
  end;

  answer := public.market_adjusted_price_at('[
    {"type_id": 34, "as_of": "2026-09-15T12:00:00Z"},
    {"type_id": 34, "as_of": "2026-09-10T00:00:00Z"},
    {"type_id": 34, "as_of": "2026-09-25T00:00:00Z"},
    {"type_id": 34, "as_of": "2026-08-01T00:00:00Z"},
    {"type_id": 35, "as_of": "2026-09-30T00:00:00Z"},
    {"type_id": 36, "as_of": "2026-09-30T00:00:00Z"}
  ]'::jsonb);

  -- One answer per probe that has any version at all; the unknown type (36) is absent.
  if json_array_length(answer) <> 5 then
    raise exception 'expected 5 answers, got %: %', json_array_length(answer), answer;
  end if;

  -- Ordered by (type_id, as_of): 34 @ 08-01, 09-10, 09-15, 09-25, then 35.
  row := answer -> 0;
  if (row ->> 'adjusted_price')::numeric <> 4.0 or (row ->> 'exact')::boolean is not false or (row ->> 'since')::timestamptz <> '2026-09-01T00:00:00Z' then
    raise exception 'a probe before the capture falls back to the earliest version, inexact: %', row;
  end if;
  row := answer -> 1;
  if (row ->> 'adjusted_price')::numeric <> 5.0 or (row ->> 'exact')::boolean is not true then
    raise exception 'a probe on a version boundary takes the version that starts there: %', row;
  end if;
  row := answer -> 2;
  if (row ->> 'adjusted_price')::numeric <> 5.0 or (row ->> 'exact')::boolean is not true then
    raise exception 'a mid-version probe takes the version in effect: %', row;
  end if;
  row := answer -> 3;
  if (row ->> 'adjusted_price')::numeric <> 6.0 or (row ->> 'exact')::boolean is not true then
    raise exception 'a probe inside the current version takes it: %', row;
  end if;
  row := answer -> 4;
  if (row ->> 'type_id')::bigint <> 35 or (row ->> 'adjusted_price')::numeric <> 12.5 then
    raise exception 'another type answers its own version: %', row;
  end if;

  if public.market_adjusted_price_at('[]'::jsonb)::text <> '[]' then
    raise exception 'no probes answers an empty array';
  end if;

  raise notice 'market_adjusted_price_at: all assertions passed';
end $$;

rollback;
