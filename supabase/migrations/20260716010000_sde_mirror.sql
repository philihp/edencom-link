-- SDE mirror: nightly-refreshed copy of CCP's official Static Data Export in
-- the public schema, populated by the `sde-mirror` Vercel Workflow (see
-- src/workflows/sdeMirror.ts / src/jobs/sdeMirror.js, scheduled 12:21 UTC).
--
-- One table per JSONL file in CCP's export, named sde_<snake_case_stem>
-- (sde_types, sde_map_solar_systems, …), each just (_key, data jsonb,
-- sde_build). Tables are created at ingest time via ensure_sde_mirror_table()
-- so a new file in CCP's export needs no migration; the app-critical ones are
-- pre-created here so the views below exist before the first ingest runs.
--
-- Access model: readable by anyone (RLS enabled with a bare SELECT policy,
-- SELECT-only grants) and writable by nobody but the service-role ingest,
-- which bypasses RLS. There are deliberately no insert/update/delete policies
-- or grants for anon/authenticated.
--
-- The app still reads the build-time generated JSON (src/generated/*.json);
-- cutting the loaders over to these tables is a follow-up.

create extension if not exists pg_trgm with schema extensions;

-- Create (or align) one SDE mirror table. SECURITY DEFINER so the ingest can
-- call it over PostgREST RPC; execute is service-role only, the stem is
-- regex-validated, and all DDL goes through format('%I'), so the service role
-- can only ever mint read-only sde_* mirror tables of this exact shape.
create or replace function public.ensure_sde_mirror_table(p_stem text, p_key_type text default 'bigint')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  if p_stem !~ '^[a-z][a-z0-9_]{0,58}$' then
    raise exception 'invalid SDE mirror table stem: %', p_stem;
  end if;
  if p_key_type not in ('bigint', 'text') then
    raise exception 'invalid SDE mirror key type: %', p_key_type;
  end if;
  v_table := 'sde_' || p_stem;
  execute format(
    'create table if not exists public.%I (_key %s primary key, data jsonb not null, sde_build bigint not null)',
    v_table,
    p_key_type
  );
  execute format('alter table public.%I enable row level security', v_table);
  execute format('drop policy if exists "Anyone reads SDE data" on public.%I', v_table);
  execute format('create policy "Anyone reads SDE data" on public.%I for select using (true)', v_table);
  execute format('grant select on public.%I to anon, authenticated', v_table);
  -- The schema's default privileges hand new tables ALL to anon/authenticated;
  -- claw the write privileges back so the mirror is read-only at the grant
  -- layer too, not just via the missing write policies.
  execute format('revoke insert, update, delete on public.%I from anon, authenticated', v_table);
  execute format('grant select, insert, update, delete on public.%I to service_role', v_table);
end
$$;

revoke execute on function public.ensure_sde_mirror_table(text, text) from public, anon, authenticated;
grant execute on function public.ensure_sde_mirror_table(text, text) to service_role;

-- Pre-create the tables the app-facing views project from.
select public.ensure_sde_mirror_table(stem)
from unnest(
  array['types', 'groups', 'categories', 'map_solar_systems', 'npc_stations', 'blueprints', 'map_planets']
) as stem;

-- One row per SDE build the ingest has seen; completed_at set only when every
-- file landed. The nightly run short-circuits when CCP's current build already
-- has a completed row (CCP ships a new build per game patch, not nightly).
create table public.sde_mirror_state (
  build_number bigint primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.sde_mirror_state enable row level security;
create policy "Anyone reads SDE data" on public.sde_mirror_state for select using (true);
grant select on public.sde_mirror_state to anon, authenticated;
revoke insert, update, delete on public.sde_mirror_state from anon, authenticated;
grant select, insert, update, delete on public.sde_mirror_state to service_role;

-- NPC station display names. The SDE carries a station's structure (system,
-- type, owning corp, operation) but not its name — that's generated in-game
-- from those pieces — so the ingest resolves names via ESI /universe/names/
-- into this side table. Never swept by build: a failed ESI resolve degrades
-- to the previous run's names rather than an empty table.
create table public.sde_npc_station_name (
  station_id bigint primary key,
  name text not null,
  updated_at timestamptz not null default now()
);
alter table public.sde_npc_station_name enable row level security;
create policy "Anyone reads SDE data" on public.sde_npc_station_name for select using (true);
grant select on public.sde_npc_station_name to anon, authenticated;
revoke insert, update, delete on public.sde_npc_station_name from anon, authenticated;
grant select, insert, update, delete on public.sde_npc_station_name to service_role;

-- Trigram indexes backing the ILIKE '%…%' in sde_search_type/sde_search_system.
create index sde_types_name_trgm on public.sde_types
  using gin ((data -> 'name' ->> 'en') extensions.gin_trgm_ops);
create index sde_map_solar_systems_name_trgm on public.sde_map_solar_systems
  using gin ((data -> 'name' ->> 'en') extensions.gin_trgm_ops);

-- ── App-shaped projections ──────────────────────────────────────────────────
-- The tuple shapes the app's SDE loaders (src/sde*.ts) use today, as views
-- over the raw jsonb mirror — the JOIN targets for the loader cutover and for
-- pushing name resolution into the asset/search functions later.

-- Published, named types with their group/category — mirrors buildSde.js's
-- buildTypes() cut.
create view public.sde_published_type
with (security_invoker = true) as
select
  t._key as type_id,
  t.data -> 'name' ->> 'en' as name,
  (t.data ->> 'groupID')::bigint as group_id,
  (g.data ->> 'categoryID')::bigint as category_id
from public.sde_types t
left join public.sde_groups g on g._key = (t.data ->> 'groupID')::bigint
where (t.data ->> 'published')::boolean
  and coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';

-- Known-space systems (30M id band): wormhole/abyssal systems never appear in
-- the industry cost-index feed — mirrors buildSde.js's buildSystems() cut.
create view public.sde_kspace_system
with (security_invoker = true) as
select
  _key as system_id,
  data -> 'name' ->> 'en' as name,
  (data ->> 'securityStatus')::real as security
from public.sde_map_solar_systems
where _key >= 30000000
  and _key < 31000000
  and coalesce(trim(data -> 'name' ->> 'en'), '') <> '';

-- NPC stations joined to their ESI-resolved display names.
create view public.sde_station
with (security_invoker = true) as
select
  s._key as station_id,
  n.name,
  (s.data ->> 'solarSystemID')::bigint as system_id
from public.sde_npc_stations s
join public.sde_npc_station_name n on n.station_id = s._key;

-- Planets with their system name (planets carry no display name in the SDE;
-- consumers derive "<system> <roman(celestial_index)>").
create view public.sde_planet
with (security_invoker = true) as
select
  p._key as planet_id,
  (p.data ->> 'solarSystemID')::bigint as system_id,
  (p.data ->> 'celestialIndex')::int as celestial_index,
  (p.data ->> 'typeID')::bigint as type_id,
  sys.data -> 'name' ->> 'en' as system_name
from public.sde_map_planets p
left join public.sde_map_solar_systems sys on sys._key = (p.data ->> 'solarSystemID')::bigint;

grant select on public.sde_published_type, public.sde_kspace_system, public.sde_station, public.sde_planet
  to anon, authenticated, service_role;
revoke insert, update, delete on public.sde_published_type, public.sde_kspace_system, public.sde_station,
  public.sde_planet from anon, authenticated;

-- Blueprint "consume materials → produce output" bill, unnested from the
-- activities jsonb once per ingest rather than per query: manufacturing (1)
-- and reactions (11) only, one row per (blueprint, activity, product) —
-- mirrors buildSde.js's buildBlueprints() cut. Materialized because the
-- lateral unnest over every blueprint is too slow to run per lookup; the
-- ingest's finalize step refreshes it via sde_refresh_views(). Created
-- populated-but-empty (sde_blueprints has no rows yet), which is what lets
-- the concurrent refresh below work on first run.
create materialized view public.sde_blueprint_product as
select
  b._key as blueprint_type_id,
  a.activity_id,
  (prod ->> 'typeID')::bigint as product_type_id,
  (prod ->> 'quantity')::bigint as product_quantity,
  coalesce(a.activity -> 'materials', '[]'::jsonb) as materials
from public.sde_blueprints b
cross join lateral (
  values (1, b.data -> 'activities' -> 'manufacturing'), (11, b.data -> 'activities' -> 'reaction')
) as a (activity_id, activity)
cross join lateral jsonb_array_elements(a.activity -> 'products') as prod
where jsonb_typeof(a.activity -> 'products') = 'array';

-- Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index sde_blueprint_product_uq
  on public.sde_blueprint_product (product_type_id, blueprint_type_id, activity_id);
create index sde_blueprint_product_bp_idx on public.sde_blueprint_product (blueprint_type_id);
-- jsonb_path_ops GIN so "what consumes type X" is a @> containment probe.
create index sde_blueprint_product_materials_idx
  on public.sde_blueprint_product using gin (materials jsonb_path_ops);

-- Materialized views can't carry RLS; SELECT-only grants give the same
-- anyone-can-read, nobody-can-write access as the tables above.
grant select on public.sde_blueprint_product to anon, authenticated, service_role;

create or replace function public.sde_refresh_views()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently public.sde_blueprint_product;
end
$$;

revoke execute on function public.sde_refresh_views() from public, anon, authenticated;
grant execute on function public.sde_refresh_views() to service_role;

-- ── Search ──────────────────────────────────────────────────────────────────
-- Case-insensitive substring search ranked exactly like src/sdeTypes.ts's
-- searchSdeTypesAll: coverage = query length / name length (a tighter match
-- ranks above a longer name containing the same term), tie-broken by shorter
-- name then id. ILIKE metacharacters in the query are escaped so they match
-- literally, mirroring the loaders' plain indexOf semantics.

create or replace function public.sde_search_type(q text, lim int default 25)
returns table (type_id bigint, name text, group_id bigint, category_id bigint, coverage real)
language sql
stable
set search_path = ''
as $$
  select
    t.type_id,
    t.name,
    t.group_id,
    t.category_id,
    char_length(btrim(q))::real / char_length(t.name) as coverage
  from public.sde_published_type t
  where btrim(q) <> ''
    and t.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by coverage desc, char_length(t.name), t.type_id
  limit least(greatest(lim, 1), 1000)
$$;

create or replace function public.sde_search_system(q text, lim int default 25)
returns table (system_id bigint, name text, security real, coverage real)
language sql
stable
set search_path = ''
as $$
  select
    s.system_id,
    s.name,
    s.security,
    char_length(btrim(q))::real / char_length(s.name) as coverage
  from public.sde_kspace_system s
  where btrim(q) <> ''
    and s.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by coverage desc, char_length(s.name), s.system_id
  limit least(greatest(lim, 1), 1000)
$$;

grant execute on function public.sde_search_type(text, int) to anon, authenticated, service_role;
grant execute on function public.sde_search_system(text, int) to anon, authenticated, service_role;
