-- SQL-level coverage for the include_shared flag on the four live asset
-- lookups behind MCP search_assets / list_assets
-- (supabase/migrations/20261014160156_asset_search_include_shared.sql):
-- by default only the caller's own rows come back, whatever RLS lets through;
-- with the flag a shared item comes back too, marked shared, with no place.
--
-- Run against a THROWAWAY database from the repo root, like the other suites:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- The share policies are stood in for by one table naming who may read which
-- item (the real recursive RLS is covered by asset_share.sql and
-- corp_asset_share.sql); what matters here is that RLS lets a foreign row
-- through and the place table does not. Everything rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;

create table public.registration (id uuid primary key, user_id uuid, corporation_id bigint);
alter table public.registration enable row level security;
create policy "own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

-- Who an item has been shared with, standing in for both share tables.
create table public.test_share (item_id bigint, user_id uuid);
grant select on public.test_share to authenticated;

create table public.sde_published_type (type_id bigint primary key, name text);
create table public.sde_station (station_id bigint primary key, name text, system_id bigint);
grant select on public.sde_published_type, public.sde_station to authenticated;
insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.sde_published_type values (34, 'Tritanium'), (587, 'Rifter'), (3467, 'Small Secure Container');

-- ── character side ────────────────────────────────────────────────────────
create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null, registration_id uuid not null, type_id bigint not null,
  location_id bigint, location_flag text, location_type text,
  quantity bigint, is_singleton boolean, name text,
  is_current boolean not null default true, valid_until timestamptz not null default now()
);
create table public.character_asset_location (
  asset_id bigint primary key references public.character_asset_version (id),
  registration_id uuid not null, location_id bigint not null, location_flag text, location_type text
);
alter table public.character_asset_version enable row level security;
alter table public.character_asset_location enable row level security;
create policy "own or shared" on public.character_asset_version for select to authenticated
  using (registration_id in (select id from public.registration)
         or item_id in (select s.item_id from public.test_share s where s.user_id = (select auth.uid())));
create policy "own places" on public.character_asset_location for select to authenticated
  using (registration_id in (select id from public.registration));
grant select on public.character_asset_version, public.character_asset_location to authenticated;

-- The view's shape (security invoker; a parent link the caller can't follow
-- reads null; a root takes its place from the location table).
create view public.character_asset with (security_invoker = on) as
  select v.item_id, v.registration_id, v.type_id, v.quantity, v.is_singleton, v.name,
         case when p.item_id is null then null else v.location_flag end as location_flag,
         case when p.item_id is null then null else v.location_id end as location_id,
         case when p.item_id is null then null else v.location_type end as location_type
  from public.character_asset_version v
  left join public.character_asset_version p on p.item_id = v.location_id and p.is_current
  where v.is_current and v.location_id is not null
  union all
  select v.item_id, v.registration_id, v.type_id, v.quantity, v.is_singleton, v.name,
         l.location_flag, l.location_id, l.location_type
  from public.character_asset_version v
  left join public.character_asset_location l on l.asset_id = v.id
  where v.is_current and v.location_id is null;
grant select on public.character_asset to authenticated;

-- ── corp side ─────────────────────────────────────────────────────────────
create table public.corp_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null, corporation_id bigint not null, type_id bigint not null,
  location_id bigint, location_flag text, location_type text,
  quantity bigint, is_singleton boolean,
  is_current boolean not null default true, valid_until timestamptz not null default now()
);
create table public.corp_asset_location (
  asset_id bigint primary key references public.corp_asset_version (id),
  corporation_id bigint not null, location_id bigint not null, location_flag text, location_type text
);
alter table public.corp_asset_version enable row level security;
alter table public.corp_asset_location enable row level security;
create policy "member or shared" on public.corp_asset_version for select to authenticated
  using (corporation_id in (select public.my_corporation_ids())
         or item_id in (select s.item_id from public.test_share s where s.user_id = (select auth.uid())));
create policy "member places" on public.corp_asset_location for select to authenticated
  using (corporation_id in (select public.my_corporation_ids()));
grant select on public.corp_asset_version, public.corp_asset_location to authenticated;

create view public.corp_asset with (security_invoker = on) as
  select v.item_id, v.corporation_id, v.type_id, v.quantity, v.is_singleton,
         case when p.item_id is null then null else v.location_flag end as location_flag,
         case when p.item_id is null then null else v.location_id end as location_id,
         case when p.item_id is null then null else v.location_type end as location_type
  from public.corp_asset_version v
  left join public.corp_asset_version p on p.item_id = v.location_id and p.is_current
  where v.is_current and v.location_id is not null
  union all
  select v.item_id, v.corporation_id, v.type_id, v.quantity, v.is_singleton,
         l.location_flag, l.location_id, l.location_type
  from public.corp_asset_version v
  left join public.corp_asset_location l on l.asset_id = v.id
  where v.is_current and v.location_id is null;
grant select on public.corp_asset to authenticated;

\i supabase/migrations/20261014160156_asset_search_include_shared.sql

-- Fixtures. Alice (corp 98001) keeps a Rifter in Jita with tritanium aboard,
-- and shares the Rifter with bob. Bob (corp 98002) keeps his own tritanium in
-- Jita. Corp 98001 keeps a container in Jita with tritanium in it, and shares
-- the container with bob.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002);

insert into public.character_asset_version (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (1001, '00000000-0000-0000-0000-0000000000aa', 587, null, null, null, 1, true),
  (1002, '00000000-0000-0000-0000-0000000000aa', 34, 1001, 'Cargo', 'item', 500, false),
  (2001, '00000000-0000-0000-0000-0000000000bb', 34, null, null, null, 40, false);
insert into public.character_asset_location
  select v.id, v.registration_id, 60003760, 'Hangar', 'station'
  from public.character_asset_version v where v.item_id in (1001, 2001);

insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (3001, 98001, 3467, null, null, null, 1, true),
  (3002, 98001, 34, 3001, 'Unlocked', 'item', 700, false);
insert into public.corp_asset_location
  select v.id, v.corporation_id, 60003760, 'CorpSAG1', 'station'
  from public.corp_asset_version v where v.item_id = 3001;

insert into public.test_share values
  (1001, 'b0000000-0000-0000-0000-000000000000'),
  (1002, 'b0000000-0000-0000-0000-000000000000'),
  (3001, 'b0000000-0000-0000-0000-000000000000'),
  (3002, 'b0000000-0000-0000-0000-000000000000');

set local role authenticated;

-- ── the owner: unchanged, with or without the flag ────────────────────────
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  assert (select count(*) from public.character_asset_search(array[34::bigint])) = 1, 'alice finds her own tritanium';
  assert (select root_location_id from public.character_asset_search(array[34::bigint])) = 60003760, 'with its place';
  assert not (select shared from public.character_asset_search(array[34::bigint])), 'and it is not shared';
  assert (select count(*) from public.character_asset_search(array[34::bigint], include_shared => true)) = 1,
    'the flag adds nothing she does not own';
  assert (select count(*) from public.corp_asset_filter(type_ids => array[34::bigint])) = 1, 'her corp''s tritanium';
end $$;

-- ── the recipient, default: only his own ──────────────────────────────────
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert (select count(*) from public.character_asset where item_id in (1001, 1002)) = 2,
    'RLS does let the shared rows through';
  assert (select count(*) from public.character_asset_search(array[34::bigint])) = 1, 'search: only bob''s own';
  assert (select registration_id from public.character_asset_search(array[34::bigint]))
    = '00000000-0000-0000-0000-0000000000bb', 'and it is his';
  assert (select count(*) from public.character_asset_filter(type_ids => array[34::bigint])) = 1, 'filter: only his own';
  assert (select count(*) from public.corp_asset_search(array[34::bigint])) = 0, 'corp search: nothing shared';
  assert (select count(*) from public.corp_asset_filter(type_ids => array[34::bigint])) = 0, 'corp filter: nothing shared';
end $$;

-- ── the recipient, include_shared: shared rows too, never their place ─────
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert (select count(*) from public.character_asset_search(array[34::bigint], include_shared => true)) = 2,
    'search: his own and alice''s shared tritanium';
  assert (select shared from public.character_asset_search(array[34::bigint], include_shared => true) where item_id = 1002),
    'the shared row is marked';
  assert (select root_location_id from public.character_asset_search(array[34::bigint], include_shared => true) where item_id = 1002) is null,
    'and names no place';
  assert (select root_location_name from public.character_asset_search(array[34::bigint], include_shared => true) where item_id = 1002) is null,
    'nor a station name';
  assert (select root_location_id from public.character_asset_search(array[34::bigint], include_shared => true) where item_id = 2001) = 60003760,
    'his own row keeps its place';
  assert (select contents from public.character_asset_search(array[587::bigint], include_shared => true) where item_id = 1001) = 1,
    'the shared ship still counts its cargo';

  assert (select count(*) from public.corp_asset_search(array[34::bigint], include_shared => true)) = 1,
    'corp search: the shared corp tritanium';
  assert (select root_location_id from public.corp_asset_search(array[34::bigint], include_shared => true)) is null,
    'with no place';
  assert (select shared from public.corp_asset_filter(type_ids => array[34::bigint], include_shared => true)),
    'corp filter marks it shared';

  -- An owner filter narrows his own rows; shared rows ride along.
  assert (select count(*) from public.character_asset_filter(
            type_ids => array[34::bigint],
            registration_ids => array['00000000-0000-0000-0000-0000000000bb'::uuid],
            include_shared => true)) = 2,
    'naming his own character keeps the shared rows on that side';
  assert (select count(*) from public.character_asset_filter(
            registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid])) = 0,
    'naming alice''s registration without the flag finds nothing';

  -- The containment filter reaches into a shared container.
  assert (select count(*) from public.corp_asset_filter(location_ids => array[3001::bigint], include_shared => true)) = 1,
    'a shared container''s id finds what is inside it';
end $$;

reset role;

\echo 'asset_search_include_shared: ALL ASSERTIONS PASSED'
rollback;
