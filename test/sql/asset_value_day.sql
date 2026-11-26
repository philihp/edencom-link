-- SQL-level coverage for asset_value_day_compute(): the daily hangar valuation
-- behind the /asset landing chart (docs/asset-valuation.md).
--
-- In SQL because the rules worth pinning live in the query: which version of
-- an item counts at a moment, that each type is priced at that day's Jita
-- split and never a later one, that blueprints stay out, that a day before
-- the price record is skipped, and that a re-run replaces a day.
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

-- Stand-ins carrying the columns the function and the policy read.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

create table public.registration (
  id uuid primary key,
  user_id uuid not null,
  corporation_id bigint
);

create or replace function public.my_corporation_ids()
returns setof bigint language sql stable as $$
  select corporation_id from public.registration where user_id = (select auth.uid()) and corporation_id is not null
$$;

create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null,
  type_id bigint not null,
  quantity bigint,
  is_current boolean not null default true,
  valid_from timestamptz not null,
  valid_until timestamptz not null
);

create table public.corp_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  quantity bigint,
  is_current boolean not null default true,
  valid_from timestamptz not null,
  valid_until timestamptz not null
);

create table public.market_price_over_time (
  type_id bigint not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  buy_max numeric,
  sell_min numeric,
  market text not null,
  is_current boolean not null default true
);

create table public.sde_published_type (
  type_id bigint primary key,
  category_id bigint
);

\i supabase/migrations/20261126193342_asset_value_day.sql

insert into public.registration values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 98000001);

insert into public.sde_published_type values (34, 4), (35, 4), (36, 4), (999, 9);

-- Prices. Tritanium (34) from 2026-09-01: 4/6 (split 5) until the 10th, then
-- 9/11 (split 10). Pyerite (35) one-sided, captured only from the 5th.
-- Mexallon (36) never captured. The C-J6MT row must never answer.
insert into public.market_price_over_time (type_id, market, valid_from, valid_until, buy_max, sell_min, is_current) values
  (34, 'jita',   '2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z',  4,  6, false),
  (34, 'jita',   '2026-09-10T00:00:00Z', '2026-09-30T00:00:00Z',  9, 11, true),
  (34, 'C-J6MT', '2026-08-01T00:00:00Z', '2026-09-30T00:00:00Z', 99, 99, true),
  (35, 'jita',   '2026-09-05T00:00:00Z', '2026-09-30T00:00:00Z', null, 100, true),
  (999, 'jita',  '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z', 1e9, 1e9, true);

-- The character's hangar:
--   item 1: 100 Tritanium from 2026-08-20, grown to 200 on the 12th (an
--           old-style close: valid_until is the last sighting, before the
--           next version begins).
--   item 2: 10 Pyerite from 2026-09-02, gone after the 8th (last seen the 8th
--           at noon, no later version).
--   item 3: 5 Mexallon, never priced.
--   item 4: a blueprint, left out even though the feed prices it.
insert into public.character_asset_version (item_id, registration_id, type_id, quantity, is_current, valid_from, valid_until) values
  (1, '00000000-0000-0000-0000-000000000001', 34, 100, false, '2026-08-20T00:00:00Z', '2026-09-11T22:00:00Z'),
  (1, '00000000-0000-0000-0000-000000000001', 34, 200, true,  '2026-09-12T04:00:00Z', '2026-09-12T04:00:00Z'),
  (2, '00000000-0000-0000-0000-000000000001', 35,  10, false, '2026-09-02T00:00:00Z', '2026-09-08T12:00:00Z'),
  (3, '00000000-0000-0000-0000-000000000001', 36,   5, true,  '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (4, '00000000-0000-0000-0000-000000000001', 999,  1, true,  '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

-- A corporation hangar: 1,000 Tritanium.
insert into public.corp_asset_version (item_id, corporation_id, type_id, quantity, is_current, valid_from, valid_until) values
  (50, 98000001, 34, 1000, true, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

do $$
declare
  reg constant uuid := '00000000-0000-0000-0000-000000000001';
  written integer;
  r record;
begin
  written := public.asset_value_day_compute(reg, null, '2026-08-30', '2026-09-12');
  -- 30 Aug ends before the price record begins: skipped, not zero. 31 Aug
  -- ends at the first capture's moment, so it is valued.
  if written <> 13 then
    raise exception 'expected 13 days written (31 Aug – 12 Sep), got %', written;
  end if;
  if exists (select 1 from public.asset_value_day where utc_day < '2026-08-31') then
    raise exception 'a day before the first price capture must not be stored';
  end if;

  -- 3 Sep: 100 Tritanium at 5; Pyerite not yet captured; Mexallon never.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-03';
  if r.value <> 500 or r.priced_types <> 1 or r.unpriced_types <> 2 or r.unpriced_units <> 15 then
    raise exception '3 Sep: expected 500 with two unpriced types (15 units), got %', row_to_json(r);
  end if;
  if r.as_of <> '2026-09-04T00:00:00Z' then
    raise exception 'a past day is valued at its end, got %', r.as_of;
  end if;

  -- 6 Sep: Pyerite now priced at its one side, 100.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-06';
  if r.value <> 1500 or r.unpriced_types <> 1 then
    raise exception '6 Sep: expected 500 + 1000 with Mexallon unpriced, got %', row_to_json(r);
  end if;

  -- 9 Sep: the Pyerite is gone. The day ends at the moment Tritanium's
  -- second version begins, so it takes that price: 100 at 10.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-09';
  if r.value <> 1000 or r.priced_types <> 1 or r.unpriced_types <> 1 then
    raise exception '9 Sep: a vanished item no longer counts, got %', row_to_json(r);
  end if;

  -- 11 Sep: the old version's last sighting (22:00) is before the end of the
  -- day, but a later version exists, so the 100 still count, now at split 10.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-11';
  if r.value <> 1000 then
    raise exception '11 Sep: a superseded version still counts until its successor, got %', row_to_json(r);
  end if;

  -- 12 Sep: 200 Tritanium at 10.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-12';
  if r.value <> 2000 then
    raise exception '12 Sep: expected 2000, got %', row_to_json(r);
  end if;

  -- A re-run replaces rather than adds.
  perform public.asset_value_day_compute(reg, null, '2026-09-12', '2026-09-12');
  if (select count(*) from public.asset_value_day where registration_id = reg and utc_day = '2026-09-12') <> 1
     or (select value from public.asset_value_day where registration_id = reg and utc_day = '2026-09-12') <> 2000 then
    raise exception 'a re-run must replace the day';
  end if;

  -- The corporation: its own key, its own hangar only.
  perform public.asset_value_day_compute(null, 98000001, '2026-09-12', '2026-09-12');
  select * into r from public.asset_value_day where corporation_id = 98000001 and utc_day = '2026-09-12';
  if r.value <> 10000 or r.owner_key <> 'corp:98000001' then
    raise exception 'corporation: expected 10000 under corp:98000001, got %', row_to_json(r);
  end if;

  -- Today is the live snapshot: current rows only, valued at the latest price.
  perform public.asset_value_day_compute(reg, null, (now() at time zone 'utc')::date, (now() at time zone 'utc')::date);
  select * into r from public.asset_value_day where registration_id = reg and utc_day = (now() at time zone 'utc')::date;
  if r.value <> 2000 then
    raise exception 'today: expected the current 200 Tritanium at 10, got %', row_to_json(r);
  end if;

  -- One owner, exactly.
  begin
    perform public.asset_value_day_compute(reg, 98000001, '2026-09-12', '2026-09-12');
    raise exception 'two owners must be refused';
  exception when sqlstate '22023' then null;
  end;

  raise notice 'asset_value_day_compute: all assertions passed';
end $$;

rollback;
