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
  corporation_id bigint,
  character_id bigint
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

create table public.sde_blueprint_product (
  blueprint_type_id bigint,
  activity_id integer,
  product_type_id bigint,
  product_quantity bigint,
  materials jsonb
);

create table public.character_industry_job_over_time (
  job_id bigint not null,
  registration_id uuid not null,
  activity_id smallint not null,
  blueprint_id bigint not null,
  blueprint_type_id bigint not null,
  runs integer not null,
  cost numeric(20, 2),
  status text not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  completed_date timestamptz,
  is_current boolean not null default true,
  valid_from timestamptz not null,
  valid_until timestamptz not null
);

create table public.corp_industry_job_over_time (
  job_id bigint not null,
  corporation_id bigint not null,
  activity_id smallint not null,
  blueprint_id bigint not null,
  blueprint_type_id bigint not null,
  runs integer not null,
  cost numeric(20, 2),
  status text not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  completed_date timestamptz,
  is_current boolean not null default true,
  valid_from timestamptz not null,
  valid_until timestamptz not null
);

create table public.character_blueprint_over_time (
  item_id bigint not null,
  material_efficiency smallint,
  valid_from timestamptz not null
);

create table public.corp_blueprint_over_time (
  item_id bigint not null,
  material_efficiency smallint,
  valid_from timestamptz not null
);

create table public.character_order_over_time (
  order_id bigint not null,
  registration_id uuid not null,
  type_id bigint not null,
  is_buy boolean not null,
  price numeric(20, 2) not null,
  volume_remain bigint not null,
  escrow numeric(20, 2),
  is_current boolean not null default true,
  valid_from timestamptz not null,
  valid_until timestamptz not null
);

create table public.character_wallet (
  registration_id uuid not null,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null
);

create table public.corp_wallet (
  corporation_id bigint not null,
  division smallint not null,
  balance numeric(20, 2) not null,
  recorded_at timestamptz not null
);

create table public.character_contract (
  registration_id uuid not null,
  contract_id bigint not null,
  type text not null,
  for_corporation boolean not null default false,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  acceptor_id bigint,
  collateral numeric(20, 2),
  date_issued timestamptz not null,
  primary key (registration_id, contract_id)
);

create table public.character_contract_status_over_time (
  registration_id uuid not null,
  contract_id bigint not null,
  status text not null,
  valid_from timestamptz not null
);

create table public.character_contract_item (
  registration_id uuid not null,
  contract_id bigint not null,
  type_id bigint not null,
  quantity bigint not null,
  is_included boolean not null
);

create table public.corp_contract (
  corporation_id bigint not null,
  contract_id bigint not null,
  type text not null,
  for_corporation boolean not null default false,
  issuer_id bigint not null,
  issuer_corporation_id bigint not null,
  acceptor_id bigint,
  collateral numeric(20, 2),
  date_issued timestamptz not null
);

create table public.corp_contract_status_over_time (
  corporation_id bigint not null,
  contract_id bigint not null,
  status text not null,
  valid_from timestamptz not null
);

create table public.corp_contract_item (
  corporation_id bigint not null,
  contract_id bigint not null,
  type_id bigint not null,
  quantity bigint not null,
  is_included boolean not null
);

\i supabase/migrations/20261126193342_asset_value_day.sql
\i supabase/migrations/20261126202934_asset_value_day_parts.sql
\i supabase/migrations/20261127091204_asset_value_day_owner_scope.sql

insert into public.registration values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 98000001, 9001001),
  -- An alt on the same account.
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000aa', null, 9001002);

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

-- An item that changed owner: 300 Tritanium the alt held from the 1st and gave
-- away on the 5th at 20:00, in another corporation's hangar only from the 10th
-- (it sat in a contract between). The receiver's later version is no reason
-- for the alt to keep counting it in the gap.
insert into public.character_asset_version (item_id, registration_id, type_id, quantity, is_current, valid_from, valid_until) values
  (60, '00000000-0000-0000-0000-000000000002', 34, 300, false, '2026-09-01T00:00:00Z', '2026-09-05T20:00:00Z');
insert into public.corp_asset_version (item_id, corporation_id, type_id, quantity, is_current, valid_from, valid_until) values
  (60, 98000002, 34, 300, true, '2026-09-10T04:00:00Z', '2026-09-10T04:00:00Z');

-- Industry. Product 40 has split 1000 from the 1st; product 41 is never priced.
insert into public.market_price_over_time (type_id, market, valid_from, valid_until, buy_max, sell_min, is_current) values
  (40, 'jita', '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z', 900, 1100, true);
-- Blueprint 400 makes one 40 from 10 Tritanium; reaction formula 500 makes 41.
insert into public.sde_blueprint_product values
  (400, 1, 40, 1, '[{"typeID": 34, "quantity": 10}]'),
  (500, 11, 41, 1, '[{"typeID": 34, "quantity": 5}]');
-- The blueprint item job 7001 ran: ME 10 before the install.
insert into public.character_blueprint_over_time values (9001, 10, '2026-09-01T00:00:00Z');

insert into public.character_industry_job_over_time
  (job_id, registration_id, activity_id, blueprint_id, blueprint_type_id, runs, cost, status, start_date, end_date, completed_date, is_current, valid_from, valid_until) values
  -- Two runs, 12th → 14th, still active, with a large fee that must not count.
  (7001, '00000000-0000-0000-0000-000000000001', 1, 9001, 400, 2, 1e6, 'active',
   '2026-09-12T00:00:00Z', '2026-09-14T00:00:00Z', null, true, '2026-09-12T04:00:00Z', '2026-09-12T04:00:00Z'),
  -- One run, done at the end of the 2nd, delivered at noon on the 3rd.
  (7002, '00000000-0000-0000-0000-000000000001', 1, 9002, 400, 1, 100, 'delivered',
   '2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z', '2026-09-03T12:00:00Z', true, '2026-09-03T12:00:00Z', '2026-09-03T12:00:00Z'),
  -- A corp job this character installed: both extracts list it; it is the corporation's.
  (7003, '00000000-0000-0000-0000-000000000001', 9, 9003, 500, 1, 100, 'active',
   '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z', null, true, '2026-09-10T04:00:00Z', '2026-09-10T04:00:00Z');

-- Market: 50 Tritanium on sale and a buy order holding 2,500 in escrow, both
-- open from the 11th; a sell order that filled and closed on the 11th.
insert into public.character_order_over_time (order_id, registration_id, type_id, is_buy, price, volume_remain, escrow, is_current, valid_from, valid_until) values
  (8001, '00000000-0000-0000-0000-000000000001', 34, false, 12, 50, null, true, '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
  (8002, '00000000-0000-0000-0000-000000000001', 35, true, 90, 25, 2500, true, '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
  (8003, '00000000-0000-0000-0000-000000000001', 34, false, 12, 70, null, false, '2026-09-05T00:00:00Z', '2026-09-11T06:00:00Z');

-- Wallets: the character's last balance before the moment; the
-- corporation's divisions each at their last balance, summed.
insert into public.character_wallet values
  ('00000000-0000-0000-0000-000000000001', 1000, '2026-09-05T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 5000, '2026-09-12T12:00:00Z');
insert into public.corp_wallet values
  (98000001, 1, 100, '2026-09-01T00:00:00Z'),
  (98000001, 2, 200, '2026-09-01T00:00:00Z'),
  (98000001, 1, 150, '2026-09-10T00:00:00Z');

-- Contracts, all issued on the 11th:
--   9101 our item exchange, outstanding: 100 Tritanium offered (1,000), and a
--        line we ask for, which is not ours.
--   9102 a courier we accepted from an outsider, in progress: collateral 3,000.
--   9103 a courier we accepted from our own alt: the alt's side counts it.
--   9104 our item exchange that finished: nothing left in flight.
insert into public.character_contract values
  ('00000000-0000-0000-0000-000000000001', 9101, 'item_exchange', false, 9001001, 98000001, null, null, '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9102, 'courier', false, 7777, 1000001, 9001001, 3000, '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9103, 'courier', false, 9001002, 1000001, 9001001, 4000, '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9104, 'item_exchange', false, 9001001, 98000001, 7777, null, '2026-09-11T00:00:00Z');
insert into public.character_contract_status_over_time values
  ('00000000-0000-0000-0000-000000000001', 9101, 'outstanding', '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9102, 'in_progress', '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9103, 'in_progress', '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9104, 'outstanding', '2026-09-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 9104, 'finished', '2026-09-11T08:00:00Z');
insert into public.character_contract_item values
  ('00000000-0000-0000-0000-000000000001', 9101, 34, 100, true),
  ('00000000-0000-0000-0000-000000000001', 9101, 35, 999, false),
  ('00000000-0000-0000-0000-000000000001', 9104, 34, 500, true);

insert into public.corp_industry_job_over_time
  (job_id, corporation_id, activity_id, blueprint_id, blueprint_type_id, runs, cost, status, start_date, end_date, completed_date, is_current, valid_from, valid_until) values
  (7003, 98000001, 9, 9003, 500, 1, 100, 'active',
   '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z', null, true, '2026-09-10T04:00:00Z', '2026-09-10T04:00:00Z');

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

  -- Jobs. End of the 12th: job 7001 is half done. Its bill at ME 10 is
  -- max(2, ceil(2 × 10 × 0.9)) = 18 Tritanium at 10 = 180; its output 2 × 1000.
  -- Half of each: 1090. The fee is not counted. Job 7003 is the corporation's.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-12';
  if r.job_value <> 1090 or r.jobs <> 1 or r.unpriced_jobs <> 0 then
    raise exception '12 Sep jobs: expected 1090 over one job, got %', row_to_json(r);
  end if;
  -- End of the 2nd: job 7002 is done but not yet delivered, so its whole
  -- output counts (1000).
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-02';
  if r.job_value <> 1000 or r.jobs <> 1 then
    raise exception '2 Sep jobs: a finished, undelivered job counts its whole output, got %', row_to_json(r);
  end if;
  -- End of the 3rd: delivered, so its output is in the hangar, not the job.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-03';
  if r.job_value <> 0 or r.jobs <> 0 then
    raise exception '3 Sep jobs: a delivered job no longer counts, got %', row_to_json(r);
  end if;
  -- The corporation's reaction makes an unpriced product: left out, counted.
  select * into r from public.asset_value_day where corporation_id = 98000001 and utc_day = '2026-09-12';
  if r.job_value <> 0 or r.jobs <> 0 or r.unpriced_jobs <> 1 then
    raise exception 'corporation jobs: an unpriced job is left out and counted, got %', row_to_json(r);
  end if;

  -- Market, contracts and wallet, end of the 12th: 50 Tritanium on sale at
  -- the split (500, not the order's 12), 2,500 escrow, contracts 1,000 +
  -- 3,000, wallet 5,000.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-12';
  if r.sell_order_value <> 500 or r.buy_escrow <> 2500 or r.contract_value <> 4000 or r.wallet <> 5000 then
    raise exception '12 Sep market/contracts/wallet: expected 500/2500/4000/5000, got %', row_to_json(r);
  end if;
  -- End of the 6th: only the order that later filled was open (70 at split
  -- 5), and the earlier balance.
  select * into r from public.asset_value_day where registration_id = reg and utc_day = '2026-09-06';
  if r.sell_order_value <> 350 or r.buy_escrow <> 0 or r.contract_value <> 0 or r.wallet <> 1000 then
    raise exception '6 Sep market/contracts/wallet: expected 350/0/0/1000, got %', row_to_json(r);
  end if;
  -- The corporation's wallet: each division at its last balance.
  select * into r from public.asset_value_day where corporation_id = 98000001 and utc_day = '2026-09-12';
  if r.wallet <> 350 then
    raise exception 'corporation wallet: expected 150 + 200, got %', row_to_json(r);
  end if;

  -- An item that changed owner counts for the giver until it left, and for
  -- the receiver from its debut; in the gap, for neither.
  perform public.asset_value_day_compute('00000000-0000-0000-0000-000000000002', null, '2026-09-04', '2026-09-11');
  perform public.asset_value_day_compute(null, 98000002, '2026-09-08', '2026-09-11');
  if (select value from public.asset_value_day
       where registration_id = '00000000-0000-0000-0000-000000000002' and utc_day = '2026-09-04') <> 1500 then
    raise exception 'moved item: the giver holds it before it left';
  end if;
  if (select value from public.asset_value_day
       where registration_id = '00000000-0000-0000-0000-000000000002' and utc_day = '2026-09-08') <> 0 then
    raise exception 'moved item: another owner''s later version must not keep it with the giver';
  end if;
  if (select value from public.asset_value_day where corporation_id = 98000002 and utc_day = '2026-09-11') <> 3000 then
    raise exception 'moved item: the receiver holds it from its debut';
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
