-- SQL-level coverage for blueprint_search() — the half of list_blueprints that
-- the node:test suite can only assert a contract against, because the filtering
-- and the by-type collapse happen in Postgres.
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real views in `public`), e.g.:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 bpsearch
--   psql -h /tmp -p 55432 -d bpsearch -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/20260725000000_blueprint_search.sql \
--     -f test/sql/blueprint_search.sql
--
-- Everything runs inside one transaction and rolls back at the end. Each check
-- is an `assert`, so the script exits non-zero on the first mismatch.
begin;

-- Stand-ins for the views/tables blueprint_search() reads. Column types match
-- the real schema; RLS is irrelevant here (the function is security invoker, so
-- scoping is the views' job, not this function's).
create table public.character_blueprint (
  item_id bigint, character_id uuid, type_id bigint, location_id bigint,
  location_flag text, quantity int, material_efficiency int, time_efficiency int, runs int
);
create table public.corp_blueprint (
  item_id bigint, corporation_id bigint, type_id bigint, location_id bigint,
  location_flag text, quantity int, material_efficiency int, time_efficiency int, runs int
);
create table public.sde_station (station_id bigint, name text, system_id bigint);
create table public.universe_structure (structure_id bigint, name text, system_id bigint);
create table public.sde_published_type (type_id bigint, name text, group_id bigint, category_id bigint);

insert into public.sde_station values (60003760, 'Jita IV - Moon 4', 30000142);
insert into public.universe_structure values (1050603051889, 'EKPB-3 Forge', 30004759);
insert into public.sde_published_type values (1001, 'Naglfar Blueprint', 105, 9), (1002, 'Rifter Blueprint', 105, 9);

-- Two blueprint types across two systems, two owners, originals and copies, one
-- stack stowed in a container (location_id resolves to no station/structure).
insert into public.character_blueprint values
  (1, '00000000-0000-0000-0000-00000000000a', 1001, 60003760,      'Hangar', -1, 10, 20, null),
  (2, '00000000-0000-0000-0000-00000000000a', 1001, 60003760,      'Hangar', -2,  2,  4,   30),
  (3, '00000000-0000-0000-0000-00000000000b', 1001, 1050603051889, 'Hangar', -2,  0,  0,   15),
  (4, '00000000-0000-0000-0000-00000000000a', 1002, 99999999,      'Hangar',  5,  0,  0, null);
insert into public.corp_blueprint values
  (5, 98000001, 1002, 60003760, 'CorpSAG1', -1, 10, 20, null);

do $$
declare
  r json;
begin
  -- ── baseline ────────────────────────────────────────────────────────────
  r := public.blueprint_search();
  assert (r ->> 'total_stacks')::int = 5, 'baseline stack count';
  -- The unresearched original is a stack of 5; every other row counts as 1.
  assert (r ->> 'total_quantity')::int = 9, 'baseline quantity';
  assert (r ->> 'originals')::int = 3 and (r ->> 'copies')::int = 2, 'baseline original/copy split';
  assert (r ->> 'distinct_types')::int = 2, 'baseline distinct types';

  -- ── system scoping ──────────────────────────────────────────────────────
  -- Jita holds the Naglfar BPO, one Naglfar copy, and the corp Rifter BPO. The
  -- container-stowed Rifter stack has no resolvable system and drops out.
  r := public.blueprint_search(system_ids => array[30000142]::bigint[]);
  assert (r ->> 'total_stacks')::int = 3, 'system scoping stack count';
  assert (r ->> 'total_quantity')::int = 3, 'system scoping excludes the container-stowed stack';

  -- A player structure resolves through universe_structure, not just NPC
  -- stations through the SDE mirror.
  r := public.blueprint_search(system_ids => array[30004759]::bigint[]);
  assert (r ->> 'total_stacks')::int = 1, 'system scoping resolves player structures';

  -- ── kind filter ─────────────────────────────────────────────────────────
  assert (public.blueprint_search(kind_filter => 'copy') ->> 'total_stacks')::int = 2, 'kind=copy';
  assert (public.blueprint_search(kind_filter => 'original') ->> 'total_stacks')::int = 3, 'kind=original';

  -- ── min_me / min_te ─────────────────────────────────────────────────────
  assert (public.blueprint_search(min_me => 10) ->> 'total_stacks')::int = 2, 'min_me=10';
  assert (public.blueprint_search(min_me => 2) ->> 'total_stacks')::int = 3, 'min_me=2';
  assert (public.blueprint_search(min_te => 20) ->> 'total_stacks')::int = 2, 'min_te=20';
  assert (public.blueprint_search(min_me => 0) ->> 'total_stacks')::int = 5, 'min_me=0 keeps everything';
  -- Filters compose: only the ME2 copy clears both.
  assert (public.blueprint_search(min_me => 2, kind_filter => 'copy') ->> 'total_stacks')::int = 1,
    'min_me and kind compose';

  -- ── owner scoping ───────────────────────────────────────────────────────
  -- An empty array on one side is how the tool excludes that half of the union.
  r := public.blueprint_search(
    character_ids => array['00000000-0000-0000-0000-00000000000a']::uuid[],
    corporation_ids => array[]::bigint[]
  );
  assert (r ->> 'total_stacks')::int = 3, 'character-only owner filter';
  r := public.blueprint_search(character_ids => array[]::uuid[], corporation_ids => array[98000001]::bigint[]);
  assert (r ->> 'total_stacks')::int = 1, 'corporation-only owner filter';

  -- ── group = 'type' stack collapsing ─────────────────────────────────────
  r := public.blueprint_search(group_mode => 'type');
  assert r ->> 'group' = 'type', 'grouped mode is echoed';
  assert json_array_length(r -> 'rows') = 2, 'five stacks collapse to two blueprint types';
  -- Totals still describe the whole filtered set, not the collapsed rows.
  assert (r ->> 'total_stacks')::int = 5, 'grouped totals still count stacks';

  -- Rows are ordered by quantity desc, so the Rifter (5 + 1) leads.
  assert (r -> 'rows' -> 0 ->> 'type_name') = 'Rifter Blueprint', 'grouped rows order by quantity';
  assert (r -> 'rows' -> 0 ->> 'stacks')::int = 2, 'Rifter stacks';
  assert (r -> 'rows' -> 0 ->> 'quantity')::int = 6, 'Rifter quantity sums the stack';
  assert (r -> 'rows' -> 0 ->> 'systems')::int = 1, 'a stack with no system does not count toward systems';

  assert (r -> 'rows' -> 1 ->> 'type_name') = 'Naglfar Blueprint', 'second collapsed row';
  assert (r -> 'rows' -> 1 ->> 'stacks')::int = 3, 'Naglfar stacks';
  assert (r -> 'rows' -> 1 ->> 'originals')::int = 1 and (r -> 'rows' -> 1 ->> 'copies')::int = 2,
    'Naglfar original/copy split';
  -- The best research held of the type, not the first row's.
  assert (r -> 'rows' -> 1 ->> 'best_material_efficiency')::int = 10, 'best ME across the collapsed stacks';
  assert (r -> 'rows' -> 1 ->> 'best_time_efficiency')::int = 20, 'best TE across the collapsed stacks';
  assert (r -> 'rows' -> 1 ->> 'copy_runs')::int = 45, 'copy runs sum across the collapsed copies';
  assert (r -> 'rows' -> 1 ->> 'systems')::int = 2, 'Naglfar spans two systems';

  -- Grouping composes with the filters rather than bypassing them.
  r := public.blueprint_search(group_mode => 'type', system_ids => array[30000142]::bigint[]);
  assert json_array_length(r -> 'rows') = 2, 'grouped rows respect the system filter';
  assert (r ->> 'total_stacks')::int = 3, 'grouped totals respect the system filter';

  -- ── display cap ─────────────────────────────────────────────────────────
  r := public.blueprint_search(row_limit => 1);
  assert json_array_length(r -> 'rows') = 1, 'row_limit caps the returned rows';
  assert (r ->> 'total_stacks')::int = 5, 'row_limit does not cap the totals';

  raise notice 'blueprint_search: all checks passed';
end $$;

rollback;
