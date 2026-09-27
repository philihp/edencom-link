-- The location split is reversible: old shape → the migration → the rollback
-- script (docs/sharing-layer/rollback-location-split.sql) gives back the
-- same table, row for row, and the views and the place table are gone.
-- Same stand-in harness as asset_location_split.sql; everything rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.registration (id uuid primary key, user_id uuid, corporation_id bigint);
create table public.corporation (corporation_id bigint primary key, alliance_id bigint);
grant select on public.registration, public.corporation to anon, authenticated;
create or replace function public.my_corporation_ids() returns setof bigint language sql stable
as $$ select r.corporation_id from public.registration r where r.user_id = (select auth.uid()) and r.corporation_id is not null $$;
create or replace function public.my_alliance_ids() returns setof bigint language sql stable
as $$ select c.alliance_id from public.registration r join public.corporation c on c.corporation_id = r.corporation_id where r.user_id = (select auth.uid()) and c.alliance_id is not null $$;

create table public.character_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references public.registration (id) on delete cascade,
  type_id bigint not null,
  location_id bigint, location_flag text, location_type text,
  quantity bigint, is_singleton boolean, is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(), valid_until timestamptz not null default now(),
  name text
);
create index character_asset_over_time_registration_id_idx on public.character_asset_over_time (registration_id);
create unique index character_asset_over_time_current_item_idx on public.character_asset_over_time (item_id) where is_current;
create index character_asset_over_time_item_id_idx on public.character_asset_over_time (item_id, valid_until desc);
create index character_asset_over_time_current_location_idx on public.character_asset_over_time (location_id) where is_current;
alter table public.character_asset_over_time enable row level security;
create policy "Users read own assets" on public.character_asset_over_time for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
create view public.character_asset with (security_invoker = on) as select * from public.character_asset_over_time where is_current;
grant select on public.character_asset_over_time to authenticated;
grant select on public.character_asset to authenticated;
create table public.corp_asset (item_id bigint, type_id bigint, location_id bigint, location_type text);
create table public.sde_published_type (type_id bigint primary key, name text);
create table public.sde_station (station_id bigint primary key, name text, system_id bigint);
grant select on public.corp_asset, public.sde_published_type, public.sde_station to anon, authenticated;

\i supabase/migrations/20260805000000_character_asset_share.sql
\i supabase/migrations/20260805010000_asset_share_recursive_rls.sql

insert into public.registration values ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001);
insert into public.character_asset_over_time (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (1001, '00000000-0000-0000-0000-0000000000aa', 17738, 60003760, 'Hangar', 'station', 1, true),
  (1002, '00000000-0000-0000-0000-0000000000aa', 2929, 1001, 'HiSlot0', 'item', 1, true),
  (1003, '00000000-0000-0000-0000-0000000000aa', 3467, 1001, 'Cargo', 'item', 1, true),
  (2001, '00000000-0000-0000-0000-0000000000aa', 587, 1035466617946, 'Hangar', 'item', 1, true),
  (4242, '00000000-0000-0000-0000-0000000000aa', 34, null, null, null, 1, false);
insert into public.character_asset_over_time (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_current) values
  (1001, '00000000-0000-0000-0000-0000000000aa', 17738, 60008494, 'Hangar', 'station', 1, true, false);

-- Every column of every row, before.
create temp table before_rows as select * from public.character_asset_over_time;

\i supabase/migrations/20260926054546_asset_location_split.sql

do $$
begin
  assert (select count(*) from public.character_asset_location) = 3,
    'the two current roots and the closed version of the ship moved their place; the null-location row has none';
  assert (select count(*) from (select * from before_rows except select * from public.character_asset_over_time) x) = 0,
    'through the views, every row reads exactly as before';
  assert (select count(*) from (select * from public.character_asset_over_time except select * from before_rows) x) = 0,
    'and nothing extra';
end $$;

\i docs/sharing-layer/rollback-location-split.sql

do $$
begin
  assert to_regclass('public.character_asset_location') is null, 'the place table is gone';
  assert to_regclass('public.character_asset_version') is null, 'the renamed table is gone';
  assert (select relkind from pg_class where oid = 'public.character_asset_over_time'::regclass) = 'r', 'character_asset_over_time is a table again';
  assert (select relkind from pg_class where oid = 'public.character_asset'::regclass) = 'v', 'character_asset is the plain view again';
  assert (select count(*) from (select * from before_rows except select * from public.character_asset_over_time) x) = 0,
    'every row is back on the table exactly as it was';
  assert (select count(*) from (select * from public.character_asset_over_time except select * from before_rows) x) = 0,
    'and nothing extra';
  assert (select conname from pg_constraint where conrelid = 'public.character_asset_over_time'::regclass and contype = 'p') = 'character_asset_over_time_pkey',
    'the primary key has its old name';
  assert (select count(*) from pg_indexes where tablename = 'character_asset_over_time'
            and indexname in ('character_asset_over_time_registration_id_idx', 'character_asset_over_time_current_item_idx',
                              'character_asset_over_time_item_id_idx', 'character_asset_over_time_current_location_idx')) = 4,
    'the four indexes have their old names';
  assert (select count(*) from pg_indexes where tablename = 'character_asset_over_time' and indexname like '%version%') = 0,
    'and none keeps the split''s name';
end $$;

\echo 'asset_location_split_rollback: ALL ASSERTIONS PASSED'
rollback;
