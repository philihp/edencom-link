-- SQL-level coverage for blueprint_search() — the half of list_blueprints that
-- the node:test suite can only assert a contract against, because the filtering,
-- the collapse and the limit all happen in Postgres (docs/mcp-tools-spec.md §1).
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real views in `public`) from the repo root, so the \i below resolves:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 bpsearch
--   DATABASE_URL='postgresql://…/bpsearch' pnpm run test:sql
--
-- The migration is loaded by this script (not before it), because a SQL-language
-- function is parsed and validated at creation time and so needs the stand-in
-- tables to already exist. Everything — the fixtures, the function, the checks —
-- runs inside one transaction and rolls back at the end, so nothing is left
-- behind. Each check is an `assert`, so psql exits non-zero on the first
-- mismatch.
--
-- Per the spec's own guidance, the assertions are on relative filtering
-- behaviour and shape rather than on production row counts, which drift as
-- research completes.
begin;

-- Stand-ins for the views/tables blueprint_search() reads. Column types match
-- the real schema; RLS is irrelevant here (the function is security invoker, so
-- scoping is the views' job, not this function's).
create table public.character_blueprint (
  item_id bigint, registration_id uuid, type_id bigint, location_id bigint,
  location_flag text, quantity int, material_efficiency smallint, time_efficiency smallint, runs int
);
create table public.corp_blueprint (
  item_id bigint, corporation_id bigint, type_id bigint, location_id bigint,
  location_flag text, quantity int, material_efficiency smallint, time_efficiency smallint, runs int
);
create table public.sde_station (station_id bigint, name text, system_id bigint);
create table public.universe_structure (structure_id bigint, name text, system_id bigint);
create table public.sde_published_type (type_id bigint, name text, group_id bigint, category_id bigint);
create table public.sde_blueprint_product (blueprint_type_id bigint, activity_id int);

insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.universe_structure values (1050603051889, 'EKPB-3 Forge', 30004759);
insert into public.sde_published_type values
  (1001, 'Naglfar Blueprint', 105, 9),
  (1002, 'Rifter Blueprint', 105, 9),
  (1003, 'Titanium Carbide Reaction Formula', 1888, 9);

-- The two real blueprints have a manufacturing activity (1). The reaction
-- formula only has the reaction activity (11) — it cannot be researched, which
-- is exactly the trap `researchable_only` exists to avoid.
insert into public.sde_blueprint_product values (1001, 1), (1002, 1), (1003, 11);

-- Eight stacks: originals (runs = -1) and copies, across two systems plus one
-- container-stowed stack, with three indistinguishable ME2/TE4 Naglfar copies
-- to exercise the collapse. quantity carries its ESI sentinels (-1 singleton,
-- -2 BPC stack) so the normalisation is under test too.
insert into public.character_blueprint values
  (1, '00000000-0000-0000-0000-00000000000a', 1001, 60003760,      'Hangar', -1, 10, 20, -1),
  (2, '00000000-0000-0000-0000-00000000000a', 1001, 60003760,      'Hangar', -2,  2,  4, 30),
  (3, '00000000-0000-0000-0000-00000000000b', 1001, 1050603051889, 'Hangar', -2,  0,  0, 15),
  (4, '00000000-0000-0000-0000-00000000000a', 1002, 99999999,      'Hangar',  5,  0,  0, -1),
  (6, '00000000-0000-0000-0000-00000000000a', 1003, 60003760,      'Hangar',  3,  0,  0, -1),
  (7, '00000000-0000-0000-0000-00000000000a', 1001, 60003760,      'Hangar', -2,  2,  4, 10),
  (8, '00000000-0000-0000-0000-00000000000a', 1001, 1050603051889, 'Hangar', -2,  2,  4, 10);
-- ME 10 but TE 0, so the below_me / below_te OR is distinguishable from an AND.
insert into public.corp_blueprint values
  (5, 98000001, 1002, 60003760, 'CorpSAG1', -1, 10, 0, -1);

-- The function under test, defined against the fixtures above. Points at the
-- newest migration that redefines blueprint_search, not the one that first
-- introduced it: the owner column it reads was renamed character_id →
-- registration_id, and the stand-in above matches the current schema. That
-- migration deliberately contains nothing but the function and its grant, so
-- including it here stays a one-line change each time the function moves.
\i supabase/migrations/20260801150000_blueprint_search_registration_ids.sql

do $$
declare
  r json;
begin
  -- ── baseline ────────────────────────────────────────────────────────────
  r := public.blueprint_search();
  assert (r ->> 'total_stacks')::int = 8, 'baseline stack count';
  -- Sentinel quantities normalise to one item each; only genuine stacks count
  -- above 1. Summing the raw column would produce negative nonsense.
  assert (r ->> 'total_quantity')::int = 14, 'baseline quantity normalises the ESI sentinels';
  assert (r ->> 'originals')::int = 4 and (r ->> 'copies')::int = 4, 'baseline original/copy split';
  assert (r ->> 'distinct_types')::int = 3, 'baseline distinct types';

  -- ── system scoping ──────────────────────────────────────────────────────
  r := public.blueprint_search(system_ids => array[30000142]::bigint[]);
  assert (r ->> 'total_stacks')::int = 5, 'system scoping stack count';
  -- The container-stowed stack has no resolvable system and drops out — the
  -- known limitation the spec asks to be recorded rather than solved here.
  r := public.blueprint_search(system_ids => array[30004759]::bigint[]);
  assert (r ->> 'total_stacks')::int = 2, 'system scoping resolves player structures';

  -- ── structure scoping ───────────────────────────────────────────────────
  r := public.blueprint_search(structure_ids => array[1050603051889]::bigint[]);
  assert (r ->> 'total_stacks')::int = 2, 'structure scoping matches location_id = structure_id';

  -- ── kind filter ─────────────────────────────────────────────────────────
  -- An original is runs = -1; every other value is a copy with that many runs.
  assert (public.blueprint_search(kind_filter => 'original') ->> 'copies')::int = 0,
    'kind=original excludes every runs <> -1 row';
  assert (public.blueprint_search(kind_filter => 'original') ->> 'total_stacks')::int = 4, 'kind=original';
  assert (public.blueprint_search(kind_filter => 'copy') ->> 'originals')::int = 0, 'kind=copy excludes originals';
  assert (public.blueprint_search(kind_filter => 'copy') ->> 'total_stacks')::int = 4, 'kind=copy';
  assert (public.blueprint_search(kind_filter => 'all') ->> 'total_stacks')::int = 8, 'kind=all is the default';

  -- ── below_me / below_te, OR'd ───────────────────────────────────────────
  assert (public.blueprint_search(below_me => 10) ->> 'total_stacks')::int = 6, 'below_me=10';
  assert (public.blueprint_search(below_te => 20) ->> 'total_stacks')::int = 7, 'below_te=20';
  -- Both given = "short of either target" (7), not "short of both" (6). This is
  -- the non-obvious reading the spec calls for.
  assert (public.blueprint_search(below_me => 10, below_te => 20) ->> 'total_stacks')::int = 7,
    'below_me and below_te are OR''d, not AND''d';
  -- A zero floor is a real filter that admits nothing, not an absent one.
  assert (public.blueprint_search(below_me => 0) ->> 'total_stacks')::int = 0, 'below_me=0 admits nothing';

  -- ── researchable_only ───────────────────────────────────────────────────
  assert (public.blueprint_search(researchable_only => true) ->> 'total_stacks')::int = 7,
    'researchable_only drops the reaction formula';
  -- The headline trap: a research-backlog query without the exclusion is
  -- flooded by formulas that permanently report 0/0.
  assert (public.blueprint_search(below_me => 10) ->> 'total_stacks')::int = 6, 'below_me alone includes the formula';
  assert (public.blueprint_search(below_me => 10, researchable_only => true) ->> 'total_stacks')::int = 5,
    'below_me with researchable_only excludes reaction formulas';

  -- ── group = 'type' ──────────────────────────────────────────────────────
  -- Collapses identical (type, ME, TE) rows: the three ME2/TE4 Naglfar copies
  -- become one row with stacks = 3.
  r := public.blueprint_search(group_mode => 'type');
  assert r ->> 'group' = 'type', 'grouped mode is echoed';
  assert (r ->> 'total_groups')::int = 6, 'eight stacks collapse to six (type, ME, TE) groups';
  assert json_array_length(r -> 'rows') = 6, 'every group is returned under the default limit';
  -- Ordered stacks-desc, so the collapsed triple leads.
  assert (r -> 'rows' -> 0 ->> 'type_name') = 'Naglfar Blueprint', 'the collapsed group leads';
  assert (r -> 'rows' -> 0 ->> 'stacks')::int = 3, 'the duplicate stack collapses to a count';
  assert (r -> 'rows' -> 0 ->> 'material_efficiency')::int = 2
     and (r -> 'rows' -> 0 ->> 'time_efficiency')::int = 4, 'the collapsed group keeps its ME/TE';
  -- The spec's assertion: counts sum back to the ungrouped row count.
  assert (
    select sum((g ->> 'stacks')::int) from json_array_elements(r -> 'rows') as g
  ) = (r ->> 'total_stacks')::int, 'grouped stack counts sum to the ungrouped row count';
  -- Totals still describe the whole filtered set, not the collapsed rows.
  assert (r ->> 'total_stacks')::int = 8, 'grouped totals still count stacks';

  -- ── group = 'type_location' ─────────────────────────────────────────────
  -- The three ME2/TE4 copies split two-in-Jita / one-in-EKPB-3.
  r := public.blueprint_search(group_mode => 'type_location');
  assert (r ->> 'total_groups')::int = 7, 'type_location splits the collapsed group by location';
  assert (
    select sum((g ->> 'stacks')::int) from json_array_elements(r -> 'rows') as g
  ) = 8, 'type_location counts also sum to the ungrouped row count';
  assert (r -> 'rows' -> 0 ->> 'location_name') is not null, 'type_location rows carry their location';

  -- Grouping composes with the filters rather than bypassing them.
  r := public.blueprint_search(group_mode => 'type', system_ids => array[30000142]::bigint[]);
  assert (r ->> 'total_stacks')::int = 5, 'grouped totals respect the system filter';
  assert (
    select sum((g ->> 'stacks')::int) from json_array_elements(r -> 'rows') as g
  ) = 5, 'grouped counts respect the system filter';

  -- ── limit ───────────────────────────────────────────────────────────────
  -- Enforced in SQL, and it caps rows without capping the totals.
  r := public.blueprint_search(row_limit => 1);
  assert json_array_length(r -> 'rows') = 1, 'row_limit caps the returned rows';
  assert (r ->> 'total_stacks')::int = 8, 'row_limit does not cap the totals';
  r := public.blueprint_search(row_limit => 5000);
  assert json_array_length(r -> 'rows') = 8, 'row_limit clamps to the 500 maximum without erroring';

  raise notice 'blueprint_search: all checks passed';
end $$;

rollback;
