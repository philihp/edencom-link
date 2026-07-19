-- Extend sde_kspace_system with constellation/region name+id so callers can
-- build a "[region]/[constellation]/[system]" path without a second round
-- trip. Additive (existing `select system_id, name, security` callers are
-- unaffected by the new trailing columns).
create or replace view public.sde_kspace_system
with (security_invoker = true) as
select
  s._key as system_id,
  s.data -> 'name' ->> 'en' as name,
  (s.data ->> 'securityStatus')::real as security,
  c._key as constellation_id,
  c.data -> 'name' ->> 'en' as constellation_name,
  r._key as region_id,
  r.data -> 'name' ->> 'en' as region_name
from public.sde_map_solar_systems s
left join public.sde_map_constellations c on c._key = (s.data ->> 'constellationID')::bigint
left join public.sde_map_regions r on r._key = (c.data ->> 'regionID')::bigint
where s._key >= 30000000
  and s._key < 31000000
  and coalesce(trim(s.data -> 'name' ->> 'en'), '') <> '';
