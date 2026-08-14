-- SQL-level coverage for character_asset_filter() / corp_asset_filter() — the
-- id-driven lookup behind the MCP list_assets tool. All three filters and the
-- containment semantics of the location list live in Postgres, so node:test
-- can only reach the argument seam (test/assetFilterQuery.test.ts).
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real views in `public`) from the repo root, so the \i below resolves:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 assetfilter
--   DATABASE_URL='postgresql://…/assetfilter' pnpm run test:sql
--
-- The migration is loaded by this script (not before it), because a SQL-language
-- function is parsed and validated at creation time and so needs the stand-in
-- tables to already exist. Everything — the fixtures, the functions, the checks
-- — runs inside one transaction and rolls back at the end, so nothing is left
-- behind. Each check is an `assert`, so psql exits non-zero on the first
-- mismatch.
begin;

-- Stand-ins for the views/tables the functions read. RLS is irrelevant here
-- (both functions are security invoker, so scoping is the views' job); the
-- *_over_time tables appear because the climb to a root location reads parents
-- from the history, not just the current snapshot.
create table public.character_asset (
  item_id bigint, registration_id uuid, type_id bigint, quantity bigint,
  is_singleton boolean, name text, location_flag text, location_id bigint, location_type text
);
create table public.character_asset_over_time (
  item_id bigint, location_id bigint, location_type text, is_current boolean, valid_until timestamptz
);
create table public.corp_asset (
  item_id bigint, corporation_id bigint, type_id bigint, quantity bigint,
  is_singleton boolean, location_flag text, location_id bigint, location_type text
);
create table public.corp_asset_over_time (
  item_id bigint, location_id bigint, location_type text, is_current boolean, valid_until timestamptz
);
create table public.sde_published_type (type_id bigint, name text, group_id bigint, category_id bigint);
create table public.sde_station (station_id bigint, name text, system_id bigint);

insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.sde_published_type values
  (34,   'Tritanium',        18,  4),
  (587,  'Rifter',           25,  6),
  (3465, 'Station Container', 12, 2),
  (4247, 'Nitrogen Fuel Block', 1136, 4);

-- Two pilots and a corp. Pilot One keeps a Jita hangar with a ship and a
-- container in it; Pilot Two keeps a stack in a nullsec structure; the corp
-- keeps tritanium in that same structure.
--
--   60003760 (Jita, station)                     ← Pilot One
--   ├── 100 Rifter (singleton)
--   │   └── 101 Tritanium ×1000                  (nested one level)
--   ├── 102 Station Container (singleton)
--   │   └── 103 Tritanium ×500                   (nested one level)
--   └── 104 Nitrogen Fuel Block ×40
--   1050603051889 (structure)
--   ├── 200 Tritanium ×250                       ← Pilot Two
--   └── 300 Tritanium ×700                       ← corp 98000001
insert into public.character_asset values
  (100, '00000000-0000-0000-0000-00000000000a', 587,  null, true,  'Sparrow', 'Hangar',    60003760,      'station'),
  (101, '00000000-0000-0000-0000-00000000000a', 34,   1000, false, null,      'Cargo',     100,           'item'),
  (102, '00000000-0000-0000-0000-00000000000a', 3465, null, true,  'Ore can', 'Hangar',    60003760,      'station'),
  (103, '00000000-0000-0000-0000-00000000000a', 34,   500,  false, null,      'AutoFit',   102,           'item'),
  (104, '00000000-0000-0000-0000-00000000000a', 4247, 40,   false, null,      'Hangar',    60003760,      'station'),
  (200, '00000000-0000-0000-0000-00000000000b', 34,   250,  false, null,      'Hangar',    1050603051889, 'other');
insert into public.corp_asset values
  (300, 98000001, 34, 700, false, 'CorpSAG1', 1050603051889, 'other');

-- The history the climb reads: one current row per item, mirroring the views.
insert into public.character_asset_over_time
  select item_id, location_id, location_type, true, now() from public.character_asset;
insert into public.corp_asset_over_time
  select item_id, location_id, location_type, true, now() from public.corp_asset;

-- Supabase provisions `authenticated`; a bare initdb cluster like the one in
-- the header doesn't, and the migration ends in grants to it. Rolled back with
-- everything else below.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;

-- The functions under test, defined against the fixtures above.
\i supabase/migrations/20260813180000_asset_filter.sql

do $$
declare
  n int;
  q bigint;
  r bigint;
  p bigint;
  t text;
  u text;
begin
  -- ── one filter at a time ────────────────────────────────────────────────
  select count(*) into n from public.character_asset_filter(type_ids => array[34]::bigint[]);
  assert n = 3, 'a type filter alone matches every stack of that type';

  select count(*) into n
    from public.character_asset_filter(registration_ids => array['00000000-0000-0000-0000-00000000000b']::uuid[]);
  assert n = 1, 'an owner filter alone matches only that owner''s rows';

  -- A station id reaches its hangar AND everything nested in the ship and the
  -- container parked there — the whole point of the containment semantics.
  select count(*) into n from public.character_asset_filter(location_ids => array[60003760]::bigint[]);
  assert n = 5, 'a location filter descends into ships and containers, not just the top level';

  -- A container id narrows to what is inside it; the container itself is a
  -- place here, not a match.
  select count(*) into n from public.character_asset_filter(location_ids => array[102]::bigint[]);
  assert n = 1, 'a container id matches its contents';
  assert not exists (select 1 from public.character_asset_filter(location_ids => array[102]::bigint[]) where item_id = 102),
    'the location itself is not one of its own contents';

  -- ── the three lists AND together ────────────────────────────────────────
  select count(*) into n from public.character_asset_filter(
    type_ids => array[34]::bigint[], location_ids => array[60003760]::bigint[]);
  assert n = 2, 'type and location intersect: the Jita tritanium, not the fuel blocks or the nullsec stack';

  select count(*) into n from public.character_asset_filter(
    type_ids => array[34]::bigint[],
    location_ids => array[60003760]::bigint[],
    registration_ids => array['00000000-0000-0000-0000-00000000000b']::uuid[]);
  assert n = 0, 'a filter no row satisfies returns nothing rather than falling back to a wider match';

  select count(*) into n from public.character_asset_filter(
    type_ids => array[34, 4247]::bigint[], location_ids => array[60003760]::bigint[]);
  assert n = 3, 'each list is a union within itself and an intersection against the others';

  -- ── empty and absent lists mean "any" ───────────────────────────────────
  select count(*) into n from public.character_asset_filter(
    type_ids => array[4247]::bigint[], location_ids => array[]::bigint[], registration_ids => array[]::uuid[]);
  assert n = 1, 'an empty array is no filter, the same as omitting the argument';

  -- ── row shape ───────────────────────────────────────────────────────────
  select root_location_id, root_location_name, type_name, parent_id
    into r, t, u, p
    from public.character_asset_filter(type_ids => array[34]::bigint[]) where item_id = 101;
  assert r = 60003760, 'a nested item reports the station it is ultimately in, not its container';
  assert t = 'Jita IV - Moon 4', 'the root station name comes back resolved';
  assert u = 'Tritanium', 'the SDE type name comes back resolved';
  assert p = 100, 'parent_id is the immediate container';

  select contents into q from public.character_asset_filter(type_ids => array[587]::bigint[]);
  assert q = 1, 'a ship reports how many items are nested inside it';

  select contents into q from public.character_asset_filter(type_ids => array[4247]::bigint[]);
  assert q = 0, 'an item holding nothing reports zero contents';

  select name into t from public.character_asset_filter(type_ids => array[3465]::bigint[]);
  assert t = 'Ore can', 'the custom item name survives';

  -- ── corp assets behave identically, on their own owner scope ────────────
  select count(*) into n from public.corp_asset_filter(type_ids => array[34]::bigint[]);
  assert n = 1, 'the corp function matches corp rows';

  select count(*) into n from public.corp_asset_filter(
    location_ids => array[1050603051889]::bigint[], corporation_ids => array[98000001]::bigint[]);
  assert n = 1, 'the corp owner filter takes corporation ids';

  select count(*) into n from public.corp_asset_filter(corporation_ids => array[98000002]::bigint[]);
  assert n = 0, 'a corporation with nothing here matches nothing';

  -- The two sides never bleed into each other: the character function must not
  -- see the corp stack sharing that structure, or list_assets would double-count.
  select count(*) into n from public.character_asset_filter(location_ids => array[1050603051889]::bigint[]);
  assert n = 1, 'the character function sees only character assets in a shared structure';

  raise notice 'asset_filter: all checks passed';
end $$;

rollback;
