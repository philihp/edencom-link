-- The stargate graph and the map coordinates, as app-shaped projections over
-- the nightly SDE mirror. Both exist so a map can be drawn from data instead
-- of from a hand-maintained system list (the /mercenary-dens topology was the
-- first caller); the jump view is also the foundation
-- docs/asset-proximity/01-jump-graph.md specifies.

-- The view projects from a mirror table, and a fresh reset runs before the
-- first ingest — mint the table first, the same trick the sde_mirror
-- migration uses for the other app-critical mirror tables.
select public.ensure_sde_mirror_table('map_stargates');

-- Directed system→system stargate edges. CCP ships every gate with its paired
-- return gate, so the row set is a complete directed adjacency list and a
-- consumer that wants undirected links can simply de-duplicate the pairs.
create view public.sde_system_jump
with (security_invoker = true) as
select
  (data ->> 'solarSystemID')::bigint as from_system_id,
  (data -> 'destination' ->> 'solarSystemID')::bigint as to_system_id
from public.sde_map_stargates;

grant select on public.sde_system_jump to anon, authenticated, service_role;
revoke insert, update, delete on public.sde_system_jump from anon, authenticated;

-- A system's true position in the galaxy (metres). Additive — existing callers
-- select by name, so the new trailing columns pass them by. x/z are the
-- top-down galaxy-map plane the in-game star map draws; y is galactic "up".
create or replace view public.sde_kspace_system
with (security_invoker = true) as
select
  s._key as system_id,
  s.data -> 'name' ->> 'en' as name,
  (s.data ->> 'securityStatus')::real as security,
  c._key as constellation_id,
  c.data -> 'name' ->> 'en' as constellation_name,
  r._key as region_id,
  r.data -> 'name' ->> 'en' as region_name,
  (s.data -> 'position' ->> 'x')::double precision as position_x,
  (s.data -> 'position' ->> 'y')::double precision as position_y,
  (s.data -> 'position' ->> 'z')::double precision as position_z
from public.sde_map_solar_systems s
left join public.sde_map_constellations c on c._key = (s.data ->> 'constellationID')::bigint
left join public.sde_map_regions r on r._key = (c.data ->> 'regionID')::bigint
where s._key >= 30000000
  and s._key < 31000000
  and coalesce(trim(s.data -> 'name' ->> 'en'), '') <> '';
