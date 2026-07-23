-- Taxonomy + universe exploration views over the SDE mirror, for the MCP
-- search/exploration endpoints (docs/mcp-search-exploration.md, PR 1).
--
-- Adds app-shaped projections for groups, categories, and regions, and extends
-- two existing views with the name/geography columns the exploration tools need
-- so a lookup is one filtered select rather than a multi-step fan-out:
--   * sde_published_type gains group_name / category_name
--   * sde_planet         gains security / region_id / region_name
--
-- All additive. New views follow the mirror's access model exactly:
-- security_invoker over the RLS-enabled sde_* tables (whose only policy is a
-- public SELECT), SELECT granted to anon/authenticated/service_role, writes
-- revoked. The two view replacements append their new columns at the END —
-- create-or-replace requires it, and it keeps existing callers (the
-- sde_search_type RPC, the sde_name_joins functions) working unchanged.

-- Pre-create the constellation/region mirror tables these views project from,
-- so a fresh migrate (or schema.sql reset) can build the views before the
-- nightly ingest first mints the tables. ensure_sde_mirror_table is idempotent
-- (create table if not exists), so this is a no-op where the ingest already ran
-- (which, in prod, it has — the region-path migration 20260719120000 already
-- joins these tables from sde_kspace_system).
select public.ensure_sde_mirror_table(stem)
from unnest(array['map_constellations', 'map_regions']) as stem;

-- ── New taxonomy / region views ─────────────────────────────────────────────

-- Groups with their category. name/published are kept so a taxonomy browser can
-- default to published-only without losing the ability to show everything.
create view public.sde_group
with (security_invoker = true) as
select
  g._key as group_id,
  g.data -> 'name' ->> 'en' as name,
  (g.data ->> 'categoryID')::bigint as category_id,
  c.data -> 'name' ->> 'en' as category_name,
  (g.data ->> 'published')::boolean as published
from public.sde_groups g
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint;

create view public.sde_category
with (security_invoker = true) as
select
  _key as category_id,
  data -> 'name' ->> 'en' as name,
  (data ->> 'published')::boolean as published
from public.sde_categories;

-- K-space regions (10M id band), mirroring sde_kspace_system's exclusion of
-- wormhole (11M) and abyssal (12M+) space; Pochven is in-band.
create view public.sde_region
with (security_invoker = true) as
select
  _key as region_id,
  data -> 'name' ->> 'en' as name
from public.sde_map_regions
where _key >= 10000000
  and _key < 11000000
  and coalesce(trim(data -> 'name' ->> 'en'), '') <> '';

grant select on public.sde_group, public.sde_category, public.sde_region
  to anon, authenticated, service_role;
revoke insert, update, delete on public.sde_group, public.sde_category, public.sde_region
  from anon, authenticated;

-- ── View extensions (append-only) ───────────────────────────────────────────

-- sde_published_type: add group_name/category_name so the exploration tools can
-- name a type's group and category without a second lookup. The group join is
-- already present (for category_id); the category join is the only addition.
create or replace view public.sde_published_type
with (security_invoker = true) as
select
  t._key as type_id,
  t.data -> 'name' ->> 'en' as name,
  (t.data ->> 'groupID')::bigint as group_id,
  (g.data ->> 'categoryID')::bigint as category_id,
  g.data -> 'name' ->> 'en' as group_name,
  c.data -> 'name' ->> 'en' as category_name
from public.sde_types t
left join public.sde_groups g on g._key = (t.data ->> 'groupID')::bigint
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint
where (t.data ->> 'published')::boolean
  and coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';

-- sde_planet: add security + region so "temperate planets in <region>" is a
-- single filtered select. The solar-system join is already present (for
-- system_name); the constellation→region hop is the addition. region_* is
-- populated for wormhole planets too (11M band), but region-mode callers filter
-- to k-space region ids.
create or replace view public.sde_planet
with (security_invoker = true) as
select
  p._key as planet_id,
  (p.data ->> 'solarSystemID')::bigint as system_id,
  (p.data ->> 'celestialIndex')::int as celestial_index,
  (p.data ->> 'typeID')::bigint as type_id,
  sys.data -> 'name' ->> 'en' as system_name,
  (sys.data ->> 'securityStatus')::real as security,
  r._key as region_id,
  r.data -> 'name' ->> 'en' as region_name
from public.sde_map_planets p
left join public.sde_map_solar_systems sys on sys._key = (p.data ->> 'solarSystemID')::bigint
left join public.sde_map_constellations con on con._key = (sys.data ->> 'constellationID')::bigint
left join public.sde_map_regions r on r._key = (con.data ->> 'regionID')::bigint;
