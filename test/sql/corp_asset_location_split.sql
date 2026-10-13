-- SQL-level coverage for the corp asset location split
-- (supabase/migrations/20261013042029_corp_asset_location_split.sql,
-- docs/sharing-layer/14-corp-asset-share.md, PR 1): a corp asset's place moves
-- to a members-only table, and nothing a member sees changes.
--
-- Run against a THROWAWAY database from the repo root, like the other suites:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Stand-ins recreate the pre-split shape (corp_asset_over_time as a table),
-- fixtures go in, a snapshot of what members read is taken, then the
-- migration runs, so the backfill is under test as well as the claim.
-- Everything rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.registration (
  id uuid primary key,
  user_id uuid,
  corporation_id bigint
);
grant select on public.registration to anon, authenticated;

-- The pre-split corp table, with the names the migration renames.
create table public.corp_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  corporation_id bigint not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index corp_asset_over_time_corporation_id_idx on public.corp_asset_over_time (corporation_id);
create unique index corp_asset_over_time_current_item_idx on public.corp_asset_over_time (item_id) where is_current;
create index corp_asset_over_time_item_id_idx on public.corp_asset_over_time (item_id, valid_until desc);
create index corp_asset_over_time_current_location_idx on public.corp_asset_over_time (location_id) where is_current;
create index corp_asset_over_time_history_location_idx on public.corp_asset_over_time (location_id, valid_until desc) where not is_current;
alter table public.corp_asset_over_time enable row level security;
create policy "Users read assets for own corps"
  on public.corp_asset_over_time
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );
create view public.corp_asset with (security_invoker = on) as
  select * from public.corp_asset_over_time where is_current;
grant select on public.corp_asset_over_time to authenticated;
grant select on public.corp_asset to authenticated;
grant all on public.corp_asset_over_time to service_role;

-- What the rewritten breadcrumb reads on the character side (post phase 11,
-- empty here), and the SDE tables the walks label with.
create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  is_current boolean not null default true,
  name text
);
create table public.character_asset_location (asset_id bigint primary key, location_id bigint, location_type text);
create table public.sde_published_type (type_id bigint primary key, name text);
create table public.sde_station (station_id bigint primary key, name text, system_id bigint);
grant select on public.character_asset_version, public.character_asset_location,
  public.sde_published_type, public.sde_station to anon, authenticated;

-- Fixtures: alice is in corp 98001, carol is not. The corp's Office 1001 sits
-- at station 60003760; hangar division 1 holds container 1002 with ore 1003
-- inside. Ship 2001 is in the deliveries hangar of a player structure, which
-- ESI reports as location_type 'item'. Item 4001 of corp 98002 names
-- container 1002 — another corporation's item, so by the same-owner rule a
-- place, not a parent.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', 98002);
insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.sde_published_type values (27, 'Office'), (3467, 'Small Secure Container'), (34, 'Tritanium'), (587, 'Rifter');
insert into public.corp_asset_over_time
  (item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (1001, 98001, 27, 60003760, 'OfficeFolder', 'station', 1, true),
  (1002, 98001, 3467, 1001, 'CorpSAG1', 'item', 1, true),
  (1003, 98001, 34, 1002, 'Unlocked', 'item', 500, false),
  (2001, 98001, 587, 1035466617946, 'CorpDeliveries', 'item', 1, true),
  (4001, 98002, 34, 1002, 'Unlocked', 'item', 9, false);
-- A closed version: the container's earlier division, so history is under test.
insert into public.corp_asset_over_time
  (item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_current, valid_until) values
  (1002, 98001, 3467, 1001, 'CorpSAG2', 'item', 1, true, false, '2026-10-01T00:00:00Z');

-- What a member reads before the split, for the "nothing changes" check.
create temp table member_before as select * from public.corp_asset_over_time where corporation_id = 98001;
grant select on member_before to authenticated;

\i supabase/migrations/20261013042029_corp_asset_location_split.sql

-- ── backfill ──────────────────────────────────────────────────────────────
do $$
begin
  assert (select count(*) from public.corp_asset_location) = 3,
    'the office, the ship and the other corp''s ore moved their place';
  assert (select location_id from public.corp_asset_version where item_id = 1002 and is_current) = 1001,
    'a hangar item keeps its office as a parent link';
  assert (select location_id from public.corp_asset_version where item_id = 1002 and not is_current) = 1001,
    'and so does its closed version';
  assert (select location_id from public.corp_asset_version where item_id = 1001) is null,
    'the office''s station left the version row';
  assert (select l.location_type from public.corp_asset_location l
            join public.corp_asset_version v on v.id = l.asset_id where v.item_id = 2001) = 'item',
    'a player structure is a place';
  assert (select l.location_id from public.corp_asset_location l
            join public.corp_asset_version v on v.id = l.asset_id where v.item_id = 4001) = 1002,
    'another corporation''s container is a place, not a parent';
end $$;

-- ── a member: nothing changes ─────────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  assert not exists (
    (select id, item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity,
            is_singleton, is_blueprint_copy, is_current, valid_from, valid_until from member_before)
    except
    (select id, item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity,
            is_singleton, is_blueprint_copy, is_current, valid_from, valid_until from public.corp_asset_over_time)
  ) and (select count(*) from public.corp_asset_over_time) = (select count(*) from member_before),
    'the member reads exactly the rows they read before the split';
  assert (select count(*) from public.corp_asset where location_id = 60003760) = 1,
    'the member can still ask what is at a station';
  assert (select count(*) from public.corp_asset_location_contents(60003760)) = 1,
    'station contents: the office';
  assert (select contents from public.corp_asset_location_contents(60003760) where item_id = 1001) = 2,
    'with the container and the ore inside';
  assert (select sum(quantity) from public.corp_asset_subtree_items(60003760::bigint)) = 502,
    'station subtree: office + container + 500 ore';
  assert (select sum(quantity) from public.corp_asset_subtree_items(array[1002::bigint])) = 500,
    'container subtree, many-parent form';
  assert (select root_location_id from public.corp_asset_search(array[34::bigint])) = 60003760,
    'search climbs ore → container → office to the station';
  assert (select root_location_type from public.corp_asset_search(array[34::bigint])) = 'station',
    'and names its kind';
  assert (select parent_type_id from public.corp_asset_search(array[34::bigint])) = 3467,
    'and the immediate parent''s type';
  assert (select root_location_id from public.corp_asset_filter(location_ids => array[60003760::bigint], type_ids => array[34::bigint])) = 60003760,
    'filter: a station id finds what is inside the office there';
  assert (select root_location_id from public.corp_asset_filter_at(array[98001::bigint], now(), array[34::bigint])) = 60003760,
    'filter_at: the live instant agrees';
  assert (select root_location_id from public.corp_asset_filter_at(array[98001::bigint], now(), array[587::bigint])) = 1035466617946,
    'filter_at: a root in a structure';
  assert (select count(*) from public.corp_asset_filter_at(array[98001::bigint], now(), null, array[60003760::bigint])) = 3,
    'filter_at: a station id seeds from the place table';
  assert (select location_id from public.asset_ancestors(1003) where depth = 1) = 1002, 'breadcrumb: ore in the container';
  assert (select location_id from public.asset_ancestors(1003) where depth = 2) = 1001, 'the container in the office';
  assert (select location_id from public.asset_ancestors(1003) where depth = 3) = 60003760, 'the office at the station';
  assert (select location_type from public.asset_ancestors(1003) where depth = 3) = 'station', 'with its kind';
  assert (select count(*) from public.asset_ancestors(1003)) = 3, 'and nothing past it';
end $$;

-- ── a non-member ──────────────────────────────────────────────────────────
do $$
begin
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert (select count(*) from public.corp_asset where corporation_id = 98001) = 0, 'carol sees none of 98001''s assets';
  assert (select count(*) from public.corp_asset_location where corporation_id = 98001) = 0, 'nor their places';
  assert (select location_id from public.corp_asset where item_id = 4001) = 1002,
    'her own corp''s ore still reads its place, another corporation''s container, as before';
end $$;
reset role;

-- ── the claim writes new versions split the same way ──────────────────────
update public.corp_asset_version set is_current = false where item_id = 1001 and is_current;
select public.corp_asset_claim('[
  {"item_id":1001,"corporation_id":98001,"type_id":27,"location_id":60015068,"location_flag":"OfficeFolder","location_type":"station","quantity":1,"is_singleton":true},
  {"item_id":3001,"corporation_id":98001,"type_id":3467,"location_id":30000142,"location_flag":"AutoFit","location_type":"solar_system","quantity":1,"is_singleton":true},
  {"item_id":3002,"corporation_id":98001,"type_id":34,"location_id":3001,"location_flag":"Unlocked","location_type":"item","quantity":10,"is_singleton":false}
]'::jsonb);
do $$
begin
  assert (select location_id from public.corp_asset_version where item_id = 1001 and is_current) is null,
    'the moved office''s new place went to the location table';
  assert (select location_id from public.corp_asset_over_time where item_id = 1001 and is_current) = 60015068,
    'and reads back through the view';
  assert (select location_id from public.corp_asset_version where item_id = 3002 and is_current) = 3001,
    'a child arriving with its container keeps its parent link';
  assert (select location_id from public.corp_asset_over_time where item_id = 3001 and is_current) = 30000142,
    'a container in space: its system is its place';
end $$;

-- ── a child claimed before its parent is relinked when the parent lands ──
select public.corp_asset_claim('[
  {"item_id":9002,"corporation_id":98001,"type_id":34,"location_id":9001,"location_flag":"Unlocked","location_type":"item","quantity":7,"is_singleton":false}
]'::jsonb);
do $$
begin
  assert (select location_id from public.corp_asset_version where item_id = 9002 and is_current) is null,
    'with no parent row yet, the child''s link is filed as its place';
end $$;
select public.corp_asset_claim('[
  {"item_id":9001,"corporation_id":98001,"type_id":3467,"location_id":1001,"location_flag":"CorpSAG3","location_type":"item","quantity":1,"is_singleton":true}
]'::jsonb);
do $$
begin
  assert (select location_id from public.corp_asset_version where item_id = 9002 and is_current) = 9001,
    'the parent''s claim relinked the child';
  assert (select location_flag from public.corp_asset_version where item_id = 9002 and is_current) = 'Unlocked',
    'with its flag';
  assert not exists (select 1 from public.corp_asset_location l
                       join public.corp_asset_version v on v.id = l.asset_id
                      where v.item_id = 9002 and v.is_current),
    'and the child has no place row of its own';
  assert (select location_id from public.corp_asset_version where item_id = 9001 and is_current) = 1001,
    'the new container links to the office';
end $$;

-- ── a close carries the run's clock ───────────────────────────────────────
do $$
declare
  v_clock timestamptz := '2026-10-13T12:34:56Z';
begin
  perform public.corp_asset_claim(jsonb_build_array(jsonb_build_object(
    'item_id', 1003, 'corporation_id', 98002, 'type_id', 34,
    'location_id', 60003760, 'location_flag', 'CorpDeliveries', 'location_type', 'station',
    'quantity', 500, 'is_singleton', false, 'valid_until', v_clock
  )));
  assert (select valid_until from public.corp_asset_version
           where item_id = 1003 and not is_current and corporation_id = 98001) = v_clock,
    'the previous corporation''s closed row is stamped with the claiming run''s clock';
  assert (select l.location_id from public.corp_asset_location l
            join public.corp_asset_version v on v.id = l.asset_id
           where v.item_id = 1003 and v.is_current) = 60003760,
    'and the new corporation''s version is a root with its place';
end $$;

\echo 'corp_asset_location_split: ALL ASSERTIONS PASSED'
rollback;
