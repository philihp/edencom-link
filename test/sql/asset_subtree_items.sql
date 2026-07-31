-- SQL-level coverage for character_asset_subtree_items() /
-- corp_asset_subtree_items() — the aggregate the asset-viewer appraisal sends
-- to innomin.at as one batch (docs/appraisals/02-asset-subtree-items.md). All
-- of the behaviour lives in Postgres, so node:test can't reach any of it.
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real views in `public`) from the repo root, so the \i below resolves:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 subtree
--   DATABASE_URL='postgresql://…/subtree' pnpm run test:sql
--
-- The migration is loaded by this script (not before it), because a SQL-language
-- function is parsed and validated at creation time and so needs the stand-in
-- tables to already exist. Everything — the fixtures, the functions, the checks
-- — runs inside one transaction and rolls back at the end, so nothing is left
-- behind. Each check is an `assert`, so psql exits non-zero on the first
-- mismatch.
begin;

-- Stand-ins for the two views the functions read, carrying just the columns
-- they touch. RLS is irrelevant here (both functions are security invoker, so
-- scoping is the views' job, not theirs).
create table public.character_asset (
  item_id bigint, type_id bigint, location_id bigint,
  quantity bigint, is_singleton boolean
);
create table public.corp_asset (
  item_id bigint, type_id bigint, location_id bigint,
  quantity bigint, is_singleton boolean
);

-- A hangar in Jita holding one fitted ship, a loose stack and a null-quantity
-- row, with a container nested inside the ship's cargo so the walk has to go
-- three levels deep:
--
--   60003760 (station)
--   ├── 100 Rifter (singleton)
--   │   ├── 101 Damage Control (singleton, fitted)
--   │   ├── 102 Damage Control (singleton, fitted)
--   │   ├── 103 Tritanium ×1000
--   │   └── 104 Station Container (singleton)
--   │       └── 105 Tritanium ×500
--   ├── 110 Tritanium ×250
--   └── 111 Tritanium (null quantity)
insert into public.character_asset values
  (100, 587,  60003760, null, true),
  (101, 578,  100,      null, true),
  (102, 578,  100,      null, true),
  (103, 34,   100,      1000, false),
  -- A singleton's own quantity is not trusted: ESI reports assembled items with
  -- a sentinel, and summing it raw would subtract from the stack it sits in.
  (104, 3465, 100,      -1,   true),
  (105, 34,   104,      500,  false),
  (110, 34,   60003760, 250,  false),
  (111, 34,   60003760, null, false);

-- A 70-link chain, each item inside the last, rooted in a second station. Only
-- the depth cap stops the walk short of the end.
insert into public.character_asset
  select 200 + i, 34, case when i = 0 then 500000 else 199 + i end, 1, false
  from generate_series(0, 69) as i;

-- Two items each claiming to be inside the other. ESI shouldn't produce this,
-- but a recursive CTE that met one without a cap would never terminate.
insert into public.character_asset values
  (300, 34, 301, 1, false),
  (301, 34, 300, 1, false);

-- The corp side gets the same shape in miniature: an office holding a container
-- with a stack inside it.
insert into public.corp_asset values
  (400, 27,  1050603051889, null, true),
  (401, 3465, 400,          null, true),
  (402, 34,   401,          700,  false);

-- Supabase provisions `authenticated`; a bare initdb cluster like the one in
-- the header doesn't, and the migration ends in a grant to it. Rolled back with
-- everything else below.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;

-- The functions under test, defined against the fixtures above.
\i supabase/migrations/20260801110000_asset_subtree_items.sql

do $$
declare
  q bigint;
  n int;
begin
  -- ── an item parent: a ship and everything in it ─────────────────────────
  select count(*) into n from public.character_asset_subtree_items(100);
  assert n = 3, 'a ship aggregates its contents to one row per type';

  -- The parent is excluded, so the hull is the caller's line to add, not ours.
  assert not exists (select 1 from public.character_asset_subtree_items(100) where type_id = 587),
    'the parent item is not part of its own subtree';

  -- Two fitted singletons of one type count 1 apiece, not their null quantity.
  select quantity into q from public.character_asset_subtree_items(100) where type_id = 578;
  assert q = 2, 'singletons count as one each';

  -- Cargo plus the nested container's contents, summed across two depths.
  select quantity into q from public.character_asset_subtree_items(100) where type_id = 34;
  assert q = 1500, 'quantities sum through a nested container';

  -- The container itself is contents of the ship, even though it also has some,
  -- and it counts as 1 rather than as the sentinel quantity it carries.
  select quantity into q from public.character_asset_subtree_items(100) where type_id = 3465;
  assert q = 1, 'a container counts as an item as well as a parent, at quantity one';

  -- ── a bare location parent: the whole hangar ────────────────────────────
  select count(*) into n from public.character_asset_subtree_items(60003760);
  assert n = 4, 'a station id walks every type in the hangar';

  -- The ship is contents here, having been the parent a moment ago.
  select quantity into q from public.character_asset_subtree_items(60003760) where type_id = 587;
  assert q = 1, 'a station''s ships are part of its subtree';

  -- 1000 in cargo + 500 in the container + 250 loose + 1 for the null row.
  select quantity into q from public.character_asset_subtree_items(60003760) where type_id = 34;
  assert q = 1751, 'a null quantity counts as one, not as zero or null';

  -- ── narrower and empty parents ──────────────────────────────────────────
  select quantity into q from public.character_asset_subtree_items(104) where type_id = 34;
  assert q = 500, 'a container parent reports only what is inside it';

  select count(*) into n from public.character_asset_subtree_items(105);
  assert n = 0, 'an item holding nothing has an empty subtree';

  select count(*) into n from public.character_asset_subtree_items(999999);
  assert n = 0, 'an id the caller cannot see returns no rows rather than erroring';

  -- ── depth cap ───────────────────────────────────────────────────────────
  -- 64, the same ceiling every other walk in schema.sql uses — the chain is 70
  -- long, so a missing cap would show up as 70.
  select quantity into q from public.character_asset_subtree_items(500000);
  assert q = 64, 'the walk stops at depth 64';

  -- Reaching this line at all is the assertion: a cycle terminates.
  select quantity into q from public.character_asset_subtree_items(300);
  assert q = 64, 'a location cycle terminates at the depth cap';

  -- ── corp assets behave identically ──────────────────────────────────────
  select count(*) into n from public.corp_asset_subtree_items(1050603051889);
  assert n = 3, 'the corp function walks corp assets the same way';

  select quantity into q from public.corp_asset_subtree_items(400) where type_id = 34;
  assert q = 700, 'the corp function descends through nested containers too';

  assert not exists (select 1 from public.corp_asset_subtree_items(400) where type_id = 27),
    'the corp function excludes the parent as well';

  raise notice 'asset_subtree_items: all checks passed';
end $$;

rollback;
