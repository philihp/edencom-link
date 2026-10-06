-- SQL-level coverage for the time-travel asset functions behind the MCP
-- search_assets / list_assets / browse_assets `as_of` argument:
-- character_asset_filter_at(), corp_asset_filter_at() and the two
-- *_asset_location_summary_at() rollups over them.
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real ones in `public`) from the repo root, so the \i below resolves. Like
-- test/sql/asset_filter.sql, the migration is loaded after the fixtures (a
-- SQL-language function is validated at creation time), everything runs in
-- one transaction and rolls back, and each check is an `assert`.
begin;

create table public.character_asset_version (
  id bigint primary key, item_id bigint, registration_id uuid, type_id bigint,
  location_id bigint, location_flag text, location_type text,
  quantity bigint, is_singleton boolean, is_blueprint_copy boolean,
  is_current boolean, valid_from timestamptz, valid_until timestamptz, name text
);
create table public.character_asset_location (
  asset_id bigint primary key, registration_id uuid, location_id bigint, location_flag text, location_type text
);
create table public.corp_asset_over_time (
  id bigint primary key, item_id bigint, corporation_id bigint, type_id bigint,
  location_id bigint, location_flag text, location_type text,
  quantity bigint, is_singleton boolean, is_blueprint_copy boolean,
  is_current boolean, valid_from timestamptz, valid_until timestamptz
);
create table public.sde_published_type (type_id bigint, name text);
create table public.sde_station (station_id bigint, name text, system_id bigint);

insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.sde_published_type values
  (34, 'Tritanium'), (587, 'Rifter'), (3465, 'Station Container'), (4247, 'Nitrogen Fuel Block');

-- Pilot A (…0a) and Pilot B (…0b); corp 98000001. "Then" is 2026-09-01.
--
--   60003760 Jita                           Pilot A
--   ├── 100 Rifter        08-01 → closed 09-10 (gone)
--   │   └── 101 Tritanium ×1000             08-01 → closed 09-10
--   ├── 104 Fuel ×40      08-01 → closed 09-05, then ×10 from 09-05 (open)
--   └── 105 Tritanium ×5  from 09-20 (open; did not exist then)
--   1050603051889 structure
--   ├── 200 Tritanium ×250                  Pilot B, from 08-01 (open)
--   └── 300 Station Container               corp, from 08-01 (open)
--       ├── 301 Tritanium ×700             08-01 → closed 09-15
--       └── 302 Tritanium ×900             from 09-15 (open)
insert into public.character_asset_version values
  (1, 100, '00000000-0000-0000-0000-00000000000a', 587,  null, null,    null,   null, true,  false, false, '2026-08-01', '2026-09-10', 'Sparrow'),
  (2, 101, '00000000-0000-0000-0000-00000000000a', 34,   100,  'Cargo', 'item', 1000, false, false, false, '2026-08-01', '2026-09-10', null),
  (3, 104, '00000000-0000-0000-0000-00000000000a', 4247, null, null,    null,   40,   false, false, false, '2026-08-01', '2026-09-05', null),
  (4, 104, '00000000-0000-0000-0000-00000000000a', 4247, null, null,    null,   10,   false, false, true,  '2026-09-05', '2026-09-05', null),
  (5, 105, '00000000-0000-0000-0000-00000000000a', 34,   null, null,    null,   5,    false, false, true,  '2026-09-20', '2026-09-20', null),
  (6, 200, '00000000-0000-0000-0000-00000000000b', 34,   null, null,    null,   250,  false, false, true,  '2026-08-01', '2026-08-01', null);
insert into public.character_asset_location values
  (1, '00000000-0000-0000-0000-00000000000a', 60003760,      'Hangar', 'station'),
  (3, '00000000-0000-0000-0000-00000000000a', 60003760,      'Hangar', 'station'),
  (4, '00000000-0000-0000-0000-00000000000a', 60003760,      'Hangar', 'station'),
  (5, '00000000-0000-0000-0000-00000000000a', 60003760,      'Hangar', 'station'),
  (6, '00000000-0000-0000-0000-00000000000b', 1050603051889, 'Hangar', 'item');
insert into public.corp_asset_over_time values
  (1, 300, 98000001, 3465, 1050603051889, 'CorpSAG1', 'item', null, true,  false, true,  '2026-08-01', '2026-08-01'),
  (2, 301, 98000001, 34,   300,           'CorpSAG1', 'item', 700,  false, false, false, '2026-08-01', '2026-09-15'),
  (3, 302, 98000001, 34,   300,           'CorpSAG1', 'item', 900,  false, false, true,  '2026-09-15', '2026-09-15');

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;

\i supabase/migrations/20261006003247_asset_filter_at.sql

do $$
declare
  both_pilots constant uuid[] := array['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b']::uuid[];
  pilot_a constant uuid[] := array['00000000-0000-0000-0000-00000000000a']::uuid[];
  corp constant bigint[] := array[98000001]::bigint[];
  then_ constant timestamptz := '2026-09-01T00:00:00Z';
  n int;
  q bigint;
  r bigint;
  p bigint;
  t text;
  u text;
  w text;
begin
  -- ── the snapshot is the one in effect then ──────────────────────────────
  select count(*) into n from public.character_asset_filter_at(both_pilots, then_, type_ids => array[34]::bigint[]);
  assert n = 2, 'then: the tritanium in the Rifter and Pilot B''s stack; the later stack is not there yet';

  select count(*) into n from public.character_asset_filter_at(both_pilots, now(), type_ids => array[34]::bigint[]);
  assert n = 2, 'now: the Rifter''s cargo is gone and the new stack has arrived';
  assert exists (select 1 from public.character_asset_filter_at(both_pilots, now(), type_ids => array[34]::bigint[]) where item_id = 105),
    'now includes the stack that arrived after then';

  select quantity into q from public.character_asset_filter_at(pilot_a, then_, type_ids => array[4247]::bigint[]);
  assert q = 40, 'a stack reads the quantity of its version in effect then';
  select quantity into q from public.character_asset_filter_at(pilot_a, now(), type_ids => array[4247]::bigint[]);
  assert q = 10, 'and the current quantity now';

  select count(*), max(quantity) into n, q
    from public.character_asset_filter_at(pilot_a, '2026-09-05T00:00:00Z', type_ids => array[4247]::bigint[]);
  assert n = 1 and q = 10, 'at the instant one version closes and the next opens, the item is listed once, as the newer one';

  select count(*) into n from public.character_asset_filter_at(pilot_a, '2026-07-01T00:00:00Z');
  assert n = 0, 'before anything was seen there is nothing';

  -- ── the owner list scopes ───────────────────────────────────────────────
  select count(*) into n from public.character_asset_filter_at(pilot_a, then_, type_ids => array[34]::bigint[]);
  assert n = 1, 'only the named registrations are read';

  -- ── location containment, as of then ────────────────────────────────────
  select count(*) into n from public.character_asset_filter_at(pilot_a, then_, location_ids => array[60003760]::bigint[]);
  assert n = 3, 'then: Jita held the Rifter, its cargo and the fuel';

  select count(*) into n from public.character_asset_filter_at(pilot_a, now(), location_ids => array[60003760]::bigint[]);
  assert n = 2, 'now: the fuel and the new tritanium';

  select count(*) into n from public.character_asset_filter_at(pilot_a, then_, location_ids => array[100]::bigint[]);
  assert n = 1, 'a since-vanished ship id still reaches what was aboard it then';

  -- ── row shape ───────────────────────────────────────────────────────────
  select root_location_id, root_location_name, type_name, parent_id, parent_name
    into r, t, u, p, w
    from public.character_asset_filter_at(pilot_a, then_, type_ids => array[34]::bigint[]) where item_id = 101;
  assert r = 60003760, 'a nested item climbs through a since-closed ship to the station';
  assert t = 'Jita IV - Moon 4', 'the root station name comes back resolved';
  assert u = 'Tritanium', 'the SDE type name comes back resolved';
  assert p = 100, 'parent_id is the immediate container';
  assert w = 'Sparrow', 'the parent''s custom name is the one it carried then';

  select parent_id, location_flag into p, t
    from public.character_asset_filter_at(pilot_a, then_, type_ids => array[4247]::bigint[]);
  assert p = 60003760 and t = 'Hangar', 'a root item reports its place and flag, as the live function does';

  select contents into q from public.character_asset_filter_at(pilot_a, then_, type_ids => array[587]::bigint[]);
  assert q = 1, 'a ship reports what was nested in it then';

  -- ── corp ────────────────────────────────────────────────────────────────
  select quantity, root_location_id into q, r
    from public.corp_asset_filter_at(corp, then_, type_ids => array[34]::bigint[]);
  assert q = 700 and r = 1050603051889, 'then: the corp tritanium was the closed stack, rooted at the structure';

  select quantity into q from public.corp_asset_filter_at(corp, now(), type_ids => array[34]::bigint[]);
  assert q = 900, 'now: the stack that replaced it';

  select contents into q from public.corp_asset_filter_at(corp, then_, type_ids => array[3465]::bigint[]);
  assert q = 1, 'a corp container counts its contents as of then';

  select count(*) into n from public.corp_asset_filter_at(corp, then_, location_ids => array[1050603051889]::bigint[]);
  assert n = 2, 'corp containment descends into the container';

  select count(*) into n from public.corp_asset_filter_at(array[98000002]::bigint[], then_);
  assert n = 0, 'a corporation not named reads nothing';

  -- ── the location rollups ────────────────────────────────────────────────
  select stacks, station_name into q, t
    from public.character_asset_location_summary_at(pilot_a, then_) where location_id = 60003760;
  assert q = 3 and t = 'Jita IV - Moon 4', 'then: three stacks in Jita, nested ones included';

  select stacks into q from public.character_asset_location_summary_at(pilot_a, now()) where location_id = 60003760;
  assert q = 2, 'now: two';

  select stacks into q from public.corp_asset_location_summary_at(corp, then_) where location_id = 1050603051889;
  assert q = 2, 'the corp rollup counts the container and what is in it';

  raise notice 'asset_filter_at: all checks passed';
end $$;

rollback;
