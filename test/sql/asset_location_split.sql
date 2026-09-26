-- SQL-level coverage for the asset location split
-- (supabase/migrations/20260926054546_asset_location_split.sql,
-- docs/sharing-layer/11-location-split.md): a share recipient can read a
-- shared ship and everything inside it, but never where the ship is.
--
-- Run against a THROWAWAY database from the repo root, like the other suites:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Stand-ins recreate the pre-split shape (character_asset_over_time as a
-- table), fixtures go in, then the migration runs, so the backfill is under
-- test as well as the claim. Everything rolls back.
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
create table public.corporation (
  corporation_id bigint primary key,
  alliance_id bigint
);
-- The owner policies read registration as the caller, as in prod.
grant select on public.registration, public.corporation to anon, authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

create or replace function public.my_alliance_ids()
returns setof bigint
language sql
stable
as $$
  select c.alliance_id
  from public.registration r
  join public.corporation c on c.corporation_id = r.corporation_id
  where r.user_id = (select auth.uid()) and c.alliance_id is not null;
$$;

-- The pre-split asset table, with the names the migration renames.
create table public.character_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null references public.registration (id) on delete cascade,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  name text
);
create index character_asset_over_time_registration_id_idx on public.character_asset_over_time (registration_id);
create unique index character_asset_over_time_current_item_idx on public.character_asset_over_time (item_id) where is_current;
create index character_asset_over_time_item_id_idx on public.character_asset_over_time (item_id, valid_until desc);
create index character_asset_over_time_current_location_idx on public.character_asset_over_time (location_id) where is_current;
alter table public.character_asset_over_time enable row level security;
create policy "Users read own assets"
  on public.character_asset_over_time
  for select
  to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;
grant select on public.character_asset_over_time to authenticated;
grant select on public.character_asset to authenticated;

-- What the rewritten walks read besides the asset table.
create table public.corp_asset (
  item_id bigint,
  type_id bigint,
  location_id bigint,
  location_type text
);
create table public.sde_published_type (type_id bigint primary key, name text);
create table public.sde_station (station_id bigint primary key, name text, system_id bigint);
grant select on public.corp_asset, public.sde_published_type, public.sde_station to anon, authenticated;

-- The share table and the recursive widening policy, then the split.
\i supabase/migrations/20260805000000_character_asset_share.sql
\i supabase/migrations/20260805010000_asset_share_recursive_rls.sql

-- Fixtures: alice (corp 98001) owns everything; bob is in her corp; carol is
-- unaffiliated. Alice's ship 1001 is docked at station 60003760 with a module
-- and a container (holding ore) aboard. Ship 2001 sits in a player structure,
-- which ESI reports as location_type 'item'.
insert into public.corporation values (98001, 99001);
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-000000000000', null);
insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.character_asset_over_time
  (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (1001, '00000000-0000-0000-0000-0000000000aa', 17738, 60003760, 'Hangar', 'station', 1, true),
  (1002, '00000000-0000-0000-0000-0000000000aa', 2929, 1001, 'HiSlot0', 'item', 1, true),
  (1003, '00000000-0000-0000-0000-0000000000aa', 3467, 1001, 'Cargo', 'item', 1, true),
  (1004, '00000000-0000-0000-0000-0000000000aa', 34, 1003, 'Unlocked', 'item', 500, false),
  (2001, '00000000-0000-0000-0000-0000000000aa', 587, 1035466617946, 'Hangar', 'item', 1, true);
-- A closed version: the ship's earlier dock, so history is under test too.
insert into public.character_asset_over_time
  (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_current) values
  (1001, '00000000-0000-0000-0000-0000000000aa', 17738, 60008494, 'Hangar', 'station', 1, true, false);

-- Alice shares ship 1001 with her corporation.
insert into public.character_asset_share (registration_id, item_id, corporation_ids) values
  ('00000000-0000-0000-0000-0000000000aa', 1001, '{98001}');

\i supabase/migrations/20260926054546_asset_location_split.sql

-- ── backfill ──────────────────────────────────────────────────────────────
do $$
begin
  assert (select count(*) from public.character_asset_location) = 3,
    'the two roots and the closed version of the ship moved their place';
  assert (select location_id from public.character_asset_version where item_id = 1002) = 1001,
    'a parent inside the owner''s own tree stays on the version row';
  assert (select location_id from public.character_asset_version where item_id = 1001 and is_current) is null,
    'a root item''s place left the version row';
  assert (select l.location_type from public.character_asset_location l
            join public.character_asset_version v on v.id = l.asset_id where v.item_id = 2001) = 'item',
    'a player structure (location_type item, not one of her items) is a place';
end $$;

-- ── owner: nothing changes ────────────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  assert (select location_id from public.character_asset where item_id = 1001) = 60003760,
    'the owner still sees where the ship is';
  assert (select location_flag from public.character_asset where item_id = 1001) = 'Hangar',
    'and its flag';
  assert (select location_id from public.character_asset_over_time where item_id = 1001 and not is_current) = 60008494,
    'and where it was';
  assert (select count(*) from public.character_asset where location_id = 60003760) = 1,
    'the owner can still ask what is at a station';
  assert (select location_id from public.asset_ancestors(1004) order by depth desc limit 1) = 60003760,
    'the owner''s breadcrumb still reaches the station';
  assert (select count(*) from public.character_asset_location_contents(60003760)) = 1,
    'station contents for the owner';
  assert (select sum(quantity) from public.character_asset_subtree_items(60003760::bigint)) = 503,
    'station subtree for the owner: hull + module + container + 500 ore';
  assert (select root_location_id from public.character_asset_search(array[34::bigint])) = 60003760,
    'search still names the owner''s root';
end $$;

-- ── recipient in the audience: the ship and its contents, never its place ─
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert (select count(*) from public.character_asset) = 4,
    'bob sees the shared ship and everything aboard, not the unshared ship';
  assert (select location_id from public.character_asset where item_id = 1001) is null,
    'bob does not see where the ship is';
  assert (select location_type from public.character_asset where item_id = 1001) is null,
    'nor the kind of place';
  assert (select location_flag from public.character_asset where item_id = 1001) is null,
    'nor the hangar flag';
  assert (select location_id from public.character_asset where item_id = 1003) = 1001,
    'bob can still drill from the ship into its container';
  assert (select count(*) from public.character_asset_location) = 0,
    'bob reads no places';
  assert (select count(*) from public.character_asset where location_id = 60003760) = 0,
    'asking what is at the station finds nothing for bob';
  assert (select count(*) from public.character_asset_location_contents(60003760)) = 0,
    'station contents probe finds nothing';
  assert (select count(*) from public.character_asset_subtree_items(60003760::bigint)) = 0,
    'station subtree probe finds nothing';
  assert (select sum(quantity) from public.character_asset_subtree_items(1001::bigint)) = 502,
    'the ship''s own subtree still works for bob';
  assert (select location_id from public.asset_ancestors(1004) order by depth desc limit 1) is null,
    'bob''s breadcrumb ends at the ship with no place';
  -- Deliberate for now: search joins each item to its root, and a shared
  -- item has no root for bob, so it is absent rather than shown with a null
  -- place. Restoring it is a left join plus null handling in the pages.
  assert (select count(*) from public.character_asset_search(array[34::bigint])) = 0,
    'search lists nothing for bob';
end $$;

-- ── outsiders ─────────────────────────────────────────────────────────────
do $$
begin
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  assert (select count(*) from public.character_asset) = 0, 'carol sees nothing';
end $$;
reset role;
set local role anon;
do $$
begin
  perform set_config('test.uid', '', true);
  assert (select count(*) from public.character_asset) = 0, 'anon reads the view without error, and sees nothing';
end $$;
reset role;

-- ── the claim writes new versions split the same way ──────────────────────
update public.character_asset_version set is_current = false where item_id = 1001 and is_current;
select public.character_asset_claim('[
  {"item_id":1001,"registration_id":"00000000-0000-0000-0000-0000000000aa","type_id":17738,"location_id":60015068,"location_flag":"Hangar","location_type":"station","quantity":1,"is_singleton":true},
  {"item_id":3001,"registration_id":"00000000-0000-0000-0000-0000000000aa","type_id":3467,"location_id":30000142,"location_flag":"Hangar","location_type":"solar_system","quantity":1,"is_singleton":true},
  {"item_id":3002,"registration_id":"00000000-0000-0000-0000-0000000000aa","type_id":34,"location_id":3001,"location_flag":"Unlocked","location_type":"item","quantity":10,"is_singleton":false}
]'::jsonb);

do $$
begin
  assert (select location_id from public.character_asset_version where item_id = 1001 and is_current) is null,
    'the moved ship''s new place went to the location table';
  assert (select l.location_id from public.character_asset_location l
            join public.character_asset_version v on v.id = l.asset_id
           where v.item_id = 1001 and v.is_current) = 60015068,
    'with the new station';
  assert (select location_id from public.character_asset_version where item_id = 3002 and is_current) = 3001,
    'a child arriving with its container keeps its parent link';
  assert (select location_id from public.character_asset_over_time where item_id = 3001 and is_current) = 30000142,
    'a container in space: its system is its place';
end $$;

-- ── a child claimed before its parent is relinked when the parent lands ──
-- The extract claims 1000 rows a call, in ESI's order, so a container's
-- contents can arrive a call before the container. The child's parent id is
-- filed as its place for want of a parent row; the parent's claim moves it
-- back to a parent link.
select public.character_asset_claim('[
  {"item_id":9002,"registration_id":"00000000-0000-0000-0000-0000000000aa","type_id":34,"location_id":9001,"location_flag":"Unlocked","location_type":"item","quantity":7,"is_singleton":false}
]'::jsonb);
do $$
begin
  assert (select location_id from public.character_asset_version where item_id = 9002 and is_current) is null,
    'with no parent row yet, the child''s link is filed as its place';
end $$;
select public.character_asset_claim('[
  {"item_id":9001,"registration_id":"00000000-0000-0000-0000-0000000000aa","type_id":3467,"location_id":60003760,"location_flag":"Hangar","location_type":"station","quantity":1,"is_singleton":true}
]'::jsonb);
insert into public.character_asset_share (registration_id, item_id, corporation_ids) values
  ('00000000-0000-0000-0000-0000000000aa', 9001, '{98001}');
do $$
begin
  assert (select location_id from public.character_asset_version where item_id = 9002 and is_current) = 9001,
    'the parent''s claim relinked the child';
  assert (select location_flag from public.character_asset_version where item_id = 9002 and is_current) = 'Unlocked',
    'with its flag';
  assert not exists (select 1 from public.character_asset_location l
                       join public.character_asset_version v on v.id = l.asset_id
                      where v.item_id = 9002 and v.is_current),
    'and the child has no place row of its own';
  assert (select l.location_id from public.character_asset_location l
            join public.character_asset_version v on v.id = l.asset_id
           where v.item_id = 9001 and v.is_current) = 60003760,
    'the parent''s place is the station';
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_covers(9002, '00000000-0000-0000-0000-0000000000aa'),
    'the share walk climbs through the relinked child';
end $$;

-- ── a character item inside a corp-owned container keeps its breadcrumb ──
-- The corp container is not one of the owner's own items, so it is the
-- item's place; the walk continues into corp_asset from there, as before.
insert into public.corp_asset (item_id, type_id, location_id, location_type) values (7001, 3467, 60003760, 'station');
select public.character_asset_claim('[
  {"item_id":7002,"registration_id":"00000000-0000-0000-0000-0000000000aa","type_id":34,"location_id":7001,"location_flag":"Unlocked","location_type":"item","quantity":1,"is_singleton":false}
]'::jsonb);
set local role authenticated;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  assert (select location_id from public.asset_ancestors(7002) where depth = 1) = 7001,
    'the item''s place is the corp container';
  assert (select location_id from public.asset_ancestors(7002) where depth = 2) = 60003760,
    'and the walk climbs through the corp container to its station';
end $$;
reset role;

-- ── the share walk still reaches through the ship ─────────────────────────
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert public.asset_share_covers(1001, '00000000-0000-0000-0000-0000000000aa'), 'the shared ship is covered';
  assert public.asset_share_covers(1004, '00000000-0000-0000-0000-0000000000aa'), 'ore in its container is covered';
  assert not public.asset_share_covers(2001, '00000000-0000-0000-0000-0000000000aa'), 'the other ship is not';
end $$;

\echo 'asset_location_split: ALL ASSERTIONS PASSED'
rollback;
