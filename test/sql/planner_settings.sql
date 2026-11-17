-- SQL-level coverage for the planner's settings tables (planner_settings,
-- planner_build_buy, planner_manual_stock): the rules Postgres enforces rather
-- than the app does.
--
--   * an owner reads and writes their own rows and nobody else's;
--   * a row cannot be written under another user's id;
--   * the settings defaults are the documented ones;
--   * a rate out of range, a choice other than build/buy, and a negative
--     count are refused.
--
-- Run against a THROWAWAY database from the repo root (it creates stand-in
-- tables named after the real ones): DATABASE_URL='postgresql://…/throwaway'
-- pnpm run test:sql. Everything runs in one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

-- The tables under test, verbatim from the migration minus the auth.users FKs.

-- ── planner_settings ──────────────────────────────────────────────────────
-- The industry planner's settings (/industry/planner/settings): the numbers
-- the plan computes with. One row per account; a missing row means every
-- default, so the page reads it with maybeSingle and the app holds the same
-- defaults (src/app/industry/planner/settings/settings.ts). Rates are
-- fractions (0.5 = 50%); haul costs are ISK per packaged m3. home_market names
-- a market of the hourly price capture (TRACKED_MARKETS in src/gnfMarket.js).
-- Facility tax is not here: the planner reads the two rates /settings/tax
-- already stores on user_settings.
create table public.planner_settings (
  user_id        uuid          primary key,
  overbuild      numeric(8, 5) not null default 0.5  check (overbuild between 0 and 10),
  minimum_margin numeric(8, 5) not null default 0.05 check (minimum_margin between -1 and 10),
  market_fees    numeric(8, 5) not null default 0.05 check (market_fees between 0 and 1),
  scc_tax        numeric(8, 5) not null default 0.04 check (scc_tax between 0 and 1),
  home_market    text          not null default 'C-J6MT',
  haul_import    numeric(12, 2) not null default 900 check (haul_import >= 0),
  haul_export    numeric(12, 2) not null default 900 check (haul_export >= 0),
  updated_at     timestamptz   not null default now()
);

alter table public.planner_settings enable row level security;
create policy "Users manage own planner settings"
  on public.planner_settings
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_settings to authenticated;
grant all                            on public.planner_settings to service_role;

-- ── planner_build_buy ─────────────────────────────────────────────────────
-- The sheet's ManualBuildBuy: an item type the plan always builds or always
-- buys, whatever the prices say. One row per type per account.
create table public.planner_build_buy (
  user_id    uuid   not null,
  type_id    bigint not null,
  choice     text   not null check (choice in ('build', 'buy')),
  created_at timestamptz not null default now(),
  primary key (user_id, type_id)
);

alter table public.planner_build_buy enable row level security;
create policy "Users manage own build or buy choices"
  on public.planner_build_buy
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_build_buy to authenticated;
grant all                            on public.planner_build_buy to service_role;

-- ── planner_manual_stock ──────────────────────────────────────────────────
-- The sheet's ManualStock: items the account holds that no extract can see
-- (another account's hangar, a friend's can), counted as on hand on top of
-- what the extracts find. One row per type per account.
create table public.planner_manual_stock (
  user_id    uuid   not null,
  type_id    bigint not null,
  quantity   bigint not null default 0 check (quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, type_id)
);

alter table public.planner_manual_stock enable row level security;
create policy "Users manage own manual stock"
  on public.planner_manual_stock
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.planner_manual_stock to authenticated;
grant all                            on public.planner_manual_stock to service_role;

grant usage on schema public to authenticated;

set local role authenticated;

-- Alice saves settings with only her id: every default applies.
select set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
insert into public.planner_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
do $$
declare s record;
begin
  select * into s from public.planner_settings;
  if s.overbuild <> 0.5 or s.minimum_margin <> 0.05 or s.market_fees <> 0.05 or s.scc_tax <> 0.04
     or s.home_market <> 'C-J6MT' or s.haul_import <> 900 or s.haul_export <> 900 then
    raise exception 'unexpected defaults: %', s;
  end if;
end $$;
insert into public.planner_build_buy (user_id, type_id, choice)
values ('11111111-1111-1111-1111-111111111111', 11399, 'buy');
insert into public.planner_manual_stock (user_id, type_id, quantity)
values ('11111111-1111-1111-1111-111111111111', 34, 1000);

-- Bob sees none of Alice's rows.
select set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
do $$
declare n int;
begin
  select (select count(*) from public.planner_settings)
       + (select count(*) from public.planner_build_buy)
       + (select count(*) from public.planner_manual_stock) into n;
  if n <> 0 then raise exception 'bob sees % of alice''s rows', n; end if;
end $$;

-- Bob cannot write under Alice's id, in any of the three.
do $$
begin
  insert into public.planner_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
  raise exception 'bob wrote settings under alice''s id';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  insert into public.planner_build_buy (user_id, type_id, choice)
  values ('11111111-1111-1111-1111-111111111111', 35, 'build');
  raise exception 'bob wrote a choice under alice''s id';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  insert into public.planner_manual_stock (user_id, type_id)
  values ('11111111-1111-1111-1111-111111111111', 35);
  raise exception 'bob wrote manual stock under alice''s id';
exception when insufficient_privilege then null;
end $$;

-- Back as Alice: the checks refuse bad values.
select set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
do $$
begin
  update public.planner_settings set market_fees = 1.5;
  raise exception 'market fees above 100%% were stored';
exception when check_violation then null;
end $$;
do $$
begin
  update public.planner_settings set haul_import = -1;
  raise exception 'a negative haul cost was stored';
exception when check_violation then null;
end $$;
do $$
begin
  update public.planner_build_buy set choice = 'Buid';
  raise exception 'a choice other than build or buy was stored';
exception when check_violation then null;
end $$;
do $$
begin
  update public.planner_manual_stock set quantity = -1;
  raise exception 'a negative count was stored';
exception when check_violation then null;
end $$;

rollback;
