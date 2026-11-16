-- SQL-level coverage for the id harvests the extract jobs now ask for in one
-- statement instead of paging tables with OFFSET
-- (supabase/migrations/20261116231119_disk_io_id_lookups.sql):
--
--   structure_location_candidate_ids  universe-structures' candidate structures
--   industry_job_structure_system_ids industry-systems' systems of job structures
--   corp_journal_party_ids            universe-names' corp journal parties
--   corp_industry_job_installer_ids   universe-names' corp job installers
--   asset_root_place_ids              universe-names' asset stations and systems
--
-- Each replaces JavaScript that filtered the rows it paged, so each is pinned to
-- that JavaScript's rules: which rows count (current versions only, the right
-- location columns, the window), which ids count (at or above the structure
-- floor, positive), that an id seen in several places comes back once, and that
-- nothing matching answers an empty array rather than null. The migration also
-- adds sde_types_group_idx, checked here only for existing.
--
-- Run against a THROWAWAY database (it creates stand-ins named after the real
-- tables in `public`) from the repo root, so the \i below resolves:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

-- Stand-ins carrying the columns the functions touch.
create table public.sde_types (_key bigint primary key, data jsonb);

create table public.character_asset_version (
  id bigint primary key,
  item_id bigint not null,
  location_id bigint,
  is_current boolean not null
);
create table public.character_asset_location (
  asset_id bigint primary key,
  location_id bigint not null,
  location_type text
);
create table public.corp_asset_version (
  id bigint primary key,
  item_id bigint not null,
  location_id bigint,
  is_current boolean not null
);
create table public.corp_asset_location (
  asset_id bigint primary key,
  location_id bigint not null,
  location_type text
);
create table public.character_order_over_time (location_id bigint not null, is_current boolean not null);
create table public.character_industry_job_over_time (
  installer_id bigint not null,
  facility_id bigint not null,
  station_id bigint,
  blueprint_location_id bigint not null,
  output_location_id bigint not null,
  is_current boolean not null
);
create table public.corp_industry_job_over_time (like public.character_industry_job_over_time);
create table public.character_contract (start_location_id bigint, end_location_id bigint);
create table public.corp_contract (like public.character_contract);
create table public.character_wallet_transaction (location_id bigint not null);
create table public.corp_wallet_transaction (like public.character_wallet_transaction);
create table public.character_clone_over_time (location_id bigint not null, location_type text, is_current boolean not null);
create table public.universe_structure (structure_id bigint primary key, system_id bigint);
create table public.corp_wallet_journal (date timestamptz not null, first_party_id bigint, second_party_id bigint);

\i supabase/migrations/20261116231119_disk_io_id_lookups.sql

-- ── Nothing to harvest answers an empty array ─────────────────────────────
do $$
begin
  assert public.structure_location_candidate_ids(100000000000) = '{}', 'expected no structure candidates';
  assert public.industry_job_structure_system_ids(100000000000) = '{}', 'expected no job systems';
  assert public.corp_journal_party_ids(now() - interval '30 days') = '{}', 'expected no journal parties';
  assert public.corp_industry_job_installer_ids() = '{}', 'expected no installers';
  assert public.asset_root_place_ids('station') = '{}', 'expected no stations';
end $$;

-- ── structure_location_candidate_ids ──────────────────────────────────────
-- Ids from 1000000000001 up are player structures (at or above the floor);
-- 60003760 is an NPC station; ids from 2000000000001 up are items of ours.
insert into public.character_asset_version (id, item_id, location_id, is_current) values
  (1, 2000000000001, null,          true),   -- a ship docked in structure …01
  (2, 2000000000002, null,          false),  -- a closed version: its place no longer counts
  (3, 2000000000003, 2000000000001, true),   -- a module in the ship: its location is our item
  (4, 2000000000004, null,          true);   -- in an NPC station
insert into public.character_asset_location (asset_id, location_id, location_type) values
  (1, 1000000000001, 'item'),
  (2, 1000000000002, 'item'),
  (4, 60003760, 'station');

insert into public.corp_asset_version (id, item_id, location_id, is_current) values
  (11, 2000000000011, null,          true),   -- an Office in structure …11
  (12, 2000000000012, 2000000000011, true),   -- a can in the Office: the Office's id counts,
                                              -- as corp_asset_over_time has always read it
  (13, 2000000000013, 2000000000099, true);   -- a parent that is no current item: reads null
insert into public.corp_asset_location (asset_id, location_id, location_type) values
  (11, 1000000000011, 'item');

insert into public.character_order_over_time values (1000000000021, true), (1000000000022, false), (60003760, true);
insert into public.character_industry_job_over_time values
  (90000001, 1000000000031, 1000000000032, 1000000000033, 1000000000034, true),
  (90000001, 1000000000035, null,          1000000000035, 1000000000035, false);
insert into public.corp_industry_job_over_time values
  (90000002, 1000000000041, 1000000000041, 1000000000042, 2000000000011, true);
insert into public.character_contract values (1000000000051, 1000000000052), (60003760, null);
insert into public.corp_contract values (1000000000053, 1000000000001);
insert into public.character_wallet_transaction values (1000000000061), (60003760);
insert into public.corp_wallet_transaction values (1000000000062);
insert into public.character_clone_over_time values
  (1000000000071, 'structure', true),
  (1000000000072, 'structure', false),
  (1000000000073, 'station', true);
-- A contract that starts at one of our own ships names an item, not a structure.
insert into public.corp_contract values (2000000000001, null);

do $$
declare
  got bigint[] := public.structure_location_candidate_ids(100000000000);
  want bigint[] := array[
    1000000000001, -- a current character item's place (and a corp contract's end: once)
    1000000000011, -- a corp item's place
    1000000000021, -- a current order
    1000000000031, 1000000000032, 1000000000033, 1000000000034, -- all four job columns
    1000000000041, 1000000000042, -- a corp job (its output in our Office drops below)
    1000000000051, 1000000000052, 1000000000053, -- both ends of both contract tables
    1000000000061, 1000000000062, -- both transaction tables
    1000000000071, -- a current clone in a structure
    2000000000011  -- the corp Office holding a can, as the corp asset view reads it
  ]::bigint[];
begin
  -- 2000000000011 is a corp item, not a character one, so the item filter (our
  -- characters' items, as fetchOwnedItemIds read them) does not drop it.
  assert got = want, format('structure candidates: expected %s, got %s', want, got);
end $$;

-- ── industry_job_structure_system_ids ─────────────────────────────────────
insert into public.universe_structure values
  (1000000000031, 30000001),  -- a character job's facility (station_id is …32)
  (1000000000032, 30000002),  -- that job's station: station_id wins, as row.station_id ?? row.facility_id
  (1000000000041, 30000003),  -- a corp job's station
  (1000000000035, 30000004),  -- a closed job's: no
  (1000000000099, null);      -- unresolved system: no
insert into public.character_industry_job_over_time values
  (90000003, 1000000000041, null, 1000000000041, 1000000000041, true),  -- station null: facility counts, same system once
  (90000003, 1000000000031, 60003760, 60003760, 60003760, true);         -- an NPC station: below the floor

do $$
declare
  got bigint[] := public.industry_job_structure_system_ids(100000000000);
begin
  assert got = array[30000002, 30000003]::bigint[], format('job systems: expected {30000002,30000003}, got %s', got);
end $$;

-- ── corp_journal_party_ids ────────────────────────────────────────────────
insert into public.corp_wallet_journal values
  (now() - interval '1 day',  90000001, 98000001),
  (now() - interval '2 days', 98000001, 1000001),   -- a party on two entries comes back once
  (now() - interval '3 days', 90000002, null),      -- no second party
  (now() - interval '4 days', 0, -1),               -- never a party
  (now() - interval '40 days', 90000009, 90000010); -- before the window

do $$
declare
  got bigint[] := public.corp_journal_party_ids(now() - interval '30 days');
begin
  assert got = array[1000001, 90000001, 90000002, 98000001]::bigint[], format('journal parties: got %s', got);
end $$;

-- ── corp_industry_job_installer_ids ───────────────────────────────────────
insert into public.corp_industry_job_over_time values
  (90000002, 1, null, 1, 1, true),   -- the same installer twice: once
  (90000005, 1, null, 1, 1, false),  -- a closed version: no
  (0, 1, null, 1, 1, true);          -- never an installer

do $$
declare
  got bigint[] := public.corp_industry_job_installer_ids();
begin
  assert got = array[90000002]::bigint[], format('installers: expected {90000002}, got %s', got);
end $$;

-- ── asset_root_place_ids ──────────────────────────────────────────────────
insert into public.character_asset_version (id, item_id, location_id, is_current) values
  (5, 2000000000005, null, true),
  (6, 2000000000006, null, false);
insert into public.character_asset_location (asset_id, location_id, location_type) values
  (5, 30000142, 'solar_system'),
  (6, 30000143, 'solar_system');   -- a closed version: no
insert into public.corp_asset_version (id, item_id, location_id, is_current) values
  (14, 2000000000014, null, true),
  (15, 2000000000015, null, true);
insert into public.corp_asset_location (asset_id, location_id, location_type) values
  (14, 30000144, 'solar_system'),
  (15, 60008494, 'station');

do $$
begin
  -- The station resolver reads character roots only, as it always has.
  assert public.asset_root_place_ids('station') = array[60003760]::bigint[],
    format('stations: got %s', public.asset_root_place_ids('station'));
  assert public.asset_root_place_ids('solar_system', true) = array[30000142, 30000144]::bigint[],
    format('systems: got %s', public.asset_root_place_ids('solar_system', true));
  assert public.asset_root_place_ids('solar_system') = array[30000142]::bigint[],
    format('character systems: got %s', public.asset_root_place_ids('solar_system'));
end $$;

-- ── Only the jobs may call them, and the sde_types index exists ────────────
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.structure_location_candidate_ids(bigint)',
    'public.industry_job_structure_system_ids(bigint)',
    'public.corp_journal_party_ids(timestamptz)',
    'public.corp_industry_job_installer_ids()',
    'public.asset_root_place_ids(text, boolean)'
  ]
  loop
    assert not has_function_privilege('authenticated', fn, 'execute'), format('authenticated must not call %s', fn);
    assert not has_function_privilege('anon', fn, 'execute'), format('anon must not call %s', fn);
    assert has_function_privilege('service_role', fn, 'execute'), format('service_role must call %s', fn);
  end loop;

  perform 1 from pg_indexes where schemaname = 'public' and indexname = 'sde_types_group_idx';
  assert found, 'expected sde_types_group_idx';
end $$;

rollback;
