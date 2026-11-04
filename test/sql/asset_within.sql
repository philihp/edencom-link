-- SQL-level coverage for character_asset_within() / corp_asset_within()
-- (supabase/migrations/20261104180611_asset_within.sql): the GraphQL `assets`
-- and `restock` location and hangar filters, which follow each item's parent
-- chain through containers, ships and corporation Offices.
--
-- Run against a THROWAWAY database from the repo root, like the other suites:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- The views are stood in for by the same shape asset_search_include_shared.sql
-- uses (security invoker; a parent link the caller can't follow reads null; a
-- root takes its place from the location table), and the share policies by one
-- table naming who may read which item. Everything rolls back.
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

create table public.test_share (item_id bigint, user_id uuid);
grant select on public.test_share to authenticated;

-- ── the places ────────────────────────────────────────────────────────────
-- HFC-AQ (30004000) holds a structure known only to the public directory and
-- one known only to its owner's corp_structure row. Jita (30000142) holds an
-- NPC station.
create table public.sde_station (station_id bigint primary key, name text, system_id bigint);
create table public.corp_structure (structure_id bigint primary key, corporation_id bigint, system_id bigint, name text);
create table public.universe_structure (structure_id bigint primary key, system_id bigint, name text);
grant select on public.sde_station, public.corp_structure, public.universe_structure to authenticated;
insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.universe_structure values (1035000000001, 30004000, 'HFC-AQ - Keepstar');
insert into public.corp_structure values (1035000000002, 98001, 30004000, 'HFC-AQ - Sotiyo');

-- ── character side ────────────────────────────────────────────────────────
create table public.character_asset_version (
  id bigint generated always as identity primary key,
  item_id bigint not null, registration_id uuid not null, type_id bigint not null,
  location_id bigint, location_flag text, location_type text,
  quantity bigint, is_singleton boolean, is_blueprint_copy boolean, name text,
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
         or (is_current and item_id in (select s.item_id from public.test_share s where s.user_id = (select auth.uid()))));
create policy "own places" on public.character_asset_location for select to authenticated
  using (registration_id in (select id from public.registration));
grant select on public.character_asset_version, public.character_asset_location to authenticated;

create view public.character_asset with (security_invoker = on) as
  select v.id, v.item_id, v.registration_id, v.type_id, v.quantity, v.is_singleton, v.is_blueprint_copy, v.name,
         case when p.item_id is null then null else v.location_flag end as location_flag,
         case when p.item_id is null then null else v.location_id end as location_id,
         case when p.item_id is null then null else v.location_type end as location_type
  from public.character_asset_version v
  left join public.character_asset_version p on p.item_id = v.location_id and p.is_current
  where v.is_current and v.location_id is not null
  union all
  select v.id, v.item_id, v.registration_id, v.type_id, v.quantity, v.is_singleton, v.is_blueprint_copy, v.name,
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
  quantity bigint, is_singleton boolean, is_blueprint_copy boolean,
  is_current boolean not null default true, valid_until timestamptz not null default now()
);
create table public.corp_asset_location (
  asset_id bigint primary key references public.corp_asset_version (id),
  corporation_id bigint not null, location_id bigint not null, location_flag text, location_type text
);
alter table public.corp_asset_version enable row level security;
alter table public.corp_asset_location enable row level security;
create policy "member" on public.corp_asset_version for select to authenticated
  using (corporation_id in (select r.corporation_id from public.registration r));
create policy "member places" on public.corp_asset_location for select to authenticated
  using (corporation_id in (select r.corporation_id from public.registration r));
grant select on public.corp_asset_version, public.corp_asset_location to authenticated;

create view public.corp_asset with (security_invoker = on) as
  select v.id, v.item_id, v.corporation_id, v.type_id, v.quantity, v.is_singleton, v.is_blueprint_copy,
         case when p.item_id is null then null else v.location_flag end as location_flag,
         case when p.item_id is null then null else v.location_id end as location_id,
         case when p.item_id is null then null else v.location_type end as location_type
  from public.corp_asset_version v
  left join public.corp_asset_version p on p.item_id = v.location_id and p.is_current
  where v.is_current and v.location_id is not null
  union all
  select v.id, v.item_id, v.corporation_id, v.type_id, v.quantity, v.is_singleton, v.is_blueprint_copy,
         l.location_flag, l.location_id, l.location_type
  from public.corp_asset_version v
  left join public.corp_asset_location l on l.asset_id = v.id
  where v.is_current and v.location_id is null;
grant select on public.corp_asset to authenticated;

\i supabase/migrations/20261104180611_asset_within.sql

-- The ids an assertion reads back, in item_id order.
create function pg_temp.ids(result json) returns bigint[]
language sql immutable
as $$ select coalesce(array_agg((r ->> 'item_id')::bigint order by (r ->> 'item_id')::bigint), '{}')
      from json_array_elements(result -> 'rows') r $$;

-- ── fixtures ──────────────────────────────────────────────────────────────
-- Alice is in corp 98001, bob in corp 98002.
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-000000000000', 98001),
  ('00000000-0000-0000-0000-0000000000bb', 'b0000000-0000-0000-0000-000000000000', 98002);

-- Corp 98001 keeps an Office in the HFC-AQ Keepstar:
--   5002 a container in division 3, holding tritanium (5003) and a smaller
--        container (5004) with pyerite in it (5005);
--   5010 tritanium loose in division 4;
--   5020 tritanium in division 1;
--   5030 a ship in division 3 with tritanium in its cargo (5031).
-- An Office in the HFC-AQ Sotiyo (known only through corp_structure) holds
-- 5102 in division 4. An Office in Jita holds 6002 in division 3.
-- Corp 98002 keeps 7002 in division 3 of its own Office in the same Keepstar.
insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (5001, 98001, 27,   null, null,       null,   1,   true),
  (5002, 98001, 3467, 5001, 'CorpSAG3', 'item', 1,   true),
  (5003, 98001, 34,   5002, 'Unlocked', 'item', 100, false),
  (5004, 98001, 3466, 5002, 'Unlocked', 'item', 1,   true),
  (5005, 98001, 35,   5004, 'Unlocked', 'item', 50,  false),
  (5010, 98001, 34,   5001, 'CorpSAG4', 'item', 200, false),
  (5020, 98001, 34,   5001, 'CorpSAG1', 'item', 300, false),
  (5030, 98001, 587,  5001, 'CorpSAG3', 'item', 1,   true),
  (5031, 98001, 34,   5030, 'Cargo',    'item', 10,  false),
  (5101, 98001, 27,   null, null,       null,   1,   true),
  (5102, 98001, 34,   5101, 'CorpSAG4', 'item', 400, false),
  (6001, 98001, 27,   null, null,       null,   1,   true),
  (6002, 98001, 34,   6001, 'CorpSAG3', 'item', 500, false),
  (7001, 98002, 27,   null, null,       null,   1,   true),
  (7002, 98002, 34,   7001, 'CorpSAG3', 'item', 600, false);
insert into public.corp_asset_location
  select v.id, v.corporation_id,
         case v.item_id when 5001 then 1035000000001 when 5101 then 1035000000002
                        when 6001 then 60003760 else 1035000000001 end,
         'OfficeFolder', case v.item_id when 6001 then 'station' else 'item' end
  from public.corp_asset_version v where v.location_id is null;

-- Alice keeps a ship in Jita with tritanium in its cargo, and a container in
-- Jita with tritanium in it; she shares the ship with bob. Bob keeps tritanium
-- in Jita. A stack of Alice's floats in space in HFC-AQ with no flag.
insert into public.character_asset_version (item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (1001, '00000000-0000-0000-0000-0000000000aa', 587,  null, null,       null,   1,   true),
  (1002, '00000000-0000-0000-0000-0000000000aa', 34,   1001, 'Cargo',    'item', 500, false),
  (1003, '00000000-0000-0000-0000-0000000000aa', 3467, null, null,       null,   1,   true),
  (1004, '00000000-0000-0000-0000-0000000000aa', 34,   1003, 'Unlocked', 'item', 20,  false),
  (1005, '00000000-0000-0000-0000-0000000000aa', 34,   null, null,       null,   5,   false),
  (2001, '00000000-0000-0000-0000-0000000000bb', 34,   null, null,       null,   40,  false);
insert into public.character_asset_location
  select v.id, v.registration_id,
         case v.item_id when 1005 then 30004000 else 60003760 end,
         case v.item_id when 1005 then null else 'Hangar' end,
         case v.item_id when 1005 then 'solar_system' else 'station' end
  from public.character_asset_version v where v.location_id is null;
insert into public.test_share values
  (1001, 'b0000000-0000-0000-0000-000000000000'),
  (1002, 'b0000000-0000-0000-0000-000000000000');

-- ── the reported link: corp 98001, HFC-AQ, divisions 3 and 4 ──────────────
set local role authenticated;
do $$
declare
  hfc json;
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);

  hfc := public.corp_asset_within(
    corporation_ids => array[98001::bigint],
    location_ids => array[30004000::bigint],
    include_flags => array['CorpSAG3', 'CorpSAG4']);
  assert pg_temp.ids(hfc) = array[5002, 5003, 5004, 5005, 5010, 5030, 5031, 5102]::bigint[],
    format('HFC-AQ, divisions 3 and 4, every container and ship opened: %s', pg_temp.ids(hfc));
  assert (hfc ->> 'total')::int = 8, 'total counts the same rows';
  assert (hfc -> 'rows' -> 1 ->> 'location_id')::bigint = 5002, 'a row keeps its own parent as location_id';
  assert (hfc -> 'rows' -> 1 ->> 'location_flag') = 'Unlocked', 'and its own flag';
  assert (hfc -> 'rows' -> 0 ->> 'corporation_id')::bigint = 98001, 'and its owner';

  -- One structure by id: the Office that sits there, and everything in it.
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           location_ids => array[1035000000001::bigint]))
         = array[5001, 5002, 5003, 5004, 5005, 5010, 5020, 5030, 5031]::bigint[],
    'a structure id reaches into the Office and everything in it';

  -- A container id: what it holds, at any depth, never the container.
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           location_ids => array[5002::bigint]))
         = array[5003, 5004, 5005]::bigint[],
    'a container id names its contents';

  -- The hangar filter alone covers every place.
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           include_flags => array['CorpSAG3']))
         = array[5002, 5003, 5004, 5005, 5030, 5031, 6002]::bigint[],
    'division 3 everywhere, nested items too';

  -- Exclusion follows the chain too, and composes with an inclusion.
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           include_flags => array['CorpSAG3'],
           exclude_flags => array['Cargo']))
         = array[5002, 5003, 5004, 5005, 5030, 6002]::bigint[],
    'division 3 without what sits in a cargo hold';

  -- Types narrow the walk's result.
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           type_ids => array[34::bigint],
           location_ids => array[30004000::bigint],
           include_flags => array['CorpSAG3', 'CorpSAG4']))
         = array[5003, 5010, 5031, 5102]::bigint[],
    'tritanium only';

  -- The row limit caps the rows, never the total.
  hfc := public.corp_asset_within(
    corporation_ids => array[98001::bigint],
    location_ids => array[30004000::bigint],
    include_flags => array['CorpSAG3', 'CorpSAG4'],
    row_limit => 3);
  assert pg_temp.ids(hfc) = array[5002, 5003, 5004]::bigint[], 'the first three by item_id';
  assert (hfc ->> 'total')::int = 8, 'and the whole count';
  assert json_array_length(public.corp_asset_within(
           corporation_ids => array[98001::bigint], include_flags => array['CorpSAG3'], row_limit => 0) -> 'rows') = 0,
    'a zero limit returns the count alone';

  -- Another corporation's hangar in the same structure never comes back.
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint, 98002::bigint],
           include_flags => array['CorpSAG3'])) @> array[7002]::bigint[] = false,
    'RLS keeps corp 98002 out even when the caller names it';
end $$;
reset role;

-- ── the chain is read at call time ────────────────────────────────────────
-- Move the container in division 3 to division 1, and put a new container
-- with tritanium in it in division 4.
update public.corp_asset_version set is_current = false where item_id = 5002;
insert into public.corp_asset_version (item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton) values
  (5002, 98001, 3467, 5001, 'CorpSAG1', 'item', 1,   true),
  (5050, 98001, 3467, 5001, 'CorpSAG4', 'item', 1,   true),
  (5051, 98001, 34,   5050, 'Unlocked', 'item', 70,  false);

set local role authenticated;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           location_ids => array[30004000::bigint],
           include_flags => array['CorpSAG3', 'CorpSAG4']))
         = array[5010, 5030, 5031, 5050, 5051, 5102]::bigint[],
    'the moved container takes its contents out, the new one brings its own in';
end $$;
reset role;

-- ── the service-role path: the owner list is the leak guard ───────────────
-- No RLS here (a Data Link runs on the service-role client), so only the
-- owner list keeps corp 98002 out.
do $$
begin
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98001::bigint],
           location_ids => array[1035000000001::bigint],
           include_flags => array['CorpSAG3'])) = array[5030, 5031]::bigint[],
    'only the named corporation, even where RLS would not stop the read';
  assert pg_temp.ids(public.corp_asset_within(
           corporation_ids => array[98002::bigint],
           location_ids => array[1035000000001::bigint])) = array[7001, 7002]::bigint[],
    'and the other corporation sees only its own';
  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000bb'::uuid],
           location_ids => array[30000142::bigint])) = array[2001]::bigint[],
    'bob''s registration reads bob''s Jita, none of alice''s';
end $$;

-- ── character side ────────────────────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);

  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           location_ids => array[30000142::bigint]))
         = array[1001, 1002, 1003, 1004]::bigint[],
    'a system id reaches its NPC station, and into the ship and the can there';

  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           location_ids => array[30004000::bigint]))
         = array[1005]::bigint[],
    'and what floats in space in the system itself';

  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           include_flags => array['Hangar']))
         = array[1001, 1002, 1003, 1004]::bigint[],
    'the personal hangar is everything in it, cargo and cans included';

  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           exclude_flags => array['Cargo']))
         = array[1001, 1003, 1004, 1005]::bigint[],
    'excluding the cargo hold keeps the stack with no flag';

  assert (public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           location_ids => array[1001::bigint]) -> 'rows' -> 0 ->> 'registration_id')
         = '00000000-0000-0000-0000-0000000000aa',
    'rows carry their registration';
end $$;

-- A share recipient: the shared tree, never its place.
do $$
begin
  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid, '00000000-0000-0000-0000-0000000000bb'::uuid],
           location_ids => array[30000142::bigint]))
         = array[2001]::bigint[],
    'the shared ship''s place is hidden, so a place filter finds only bob''s own';
  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           location_ids => array[1001::bigint]))
         = array[1002]::bigint[],
    'the shared ship''s id reaches its cargo';
  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           include_flags => array['Hangar'])) = '{}'::bigint[],
    'the shared ship''s own hangar is hidden too';
  assert pg_temp.ids(public.character_asset_within(
           registration_ids => array['00000000-0000-0000-0000-0000000000aa'::uuid],
           include_flags => array['Cargo'])) = array[1002]::bigint[],
    'a link inside the shared tree still counts';
end $$;
reset role;

\echo 'asset_within: ALL ASSERTIONS PASSED'
rollback;
