-- Extend sde_published_type with the type's faction (the SDE's factionID),
-- which ship memory voices a hull from (docs/ship-memory.md, "Accent"):
-- faction first, then race, so a Gila (Guristas, raceID Caldari) speaks as
-- the pirate it is rather than as the State. 1,385 types carry factionID.
--
-- Same replacement rules as 20260804000000_sde_type_volume.sql: the new
-- column is appended at the END of the select, which create-or-replace
-- requires and which keeps every existing consumer working unchanged. Access
-- is inherited from the view (security_invoker over the public-read sde_*
-- tables), so no new grants are needed.
create or replace view public.sde_published_type
with (security_invoker = true) as
select
  t._key as type_id,
  t.data -> 'name' ->> 'en' as name,
  (t.data ->> 'groupID')::bigint as group_id,
  (g.data ->> 'categoryID')::bigint as category_id,
  g.data -> 'name' ->> 'en' as group_name,
  c.data -> 'name' ->> 'en' as category_name,
  (t.data ->> 'raceID')::bigint as race_id,
  (t.data ->> 'metaGroupID')::bigint as meta_group_id,
  (t.data ->> 'volume')::double precision as volume,
  (t.data ->> 'factionID')::bigint as faction_id
from public.sde_types t
left join public.sde_groups g on g._key = (t.data ->> 'groupID')::bigint
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint
where (t.data ->> 'published')::boolean
  and coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';
