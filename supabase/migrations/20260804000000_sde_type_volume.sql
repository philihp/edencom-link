-- Extend sde_published_type with the packaged-item volume the SDE stamps on
-- every type (m³ per unit). The asset folder table multiplies it by the stack
-- size to show what a row occupies in a hangar; ships and other assembled
-- singletons carry their assembled volume here, since the SDE has no packaged
-- figure for them (that's a group-level rule the client applies, not data).
--
-- Same replacement rules as 20260728120000_sde_type_race_meta.sql: the new
-- column is appended at the END of the select — create-or-replace requires it,
-- and it keeps existing consumers (the sde_search_type RPC, the sde_name_joins
-- functions, src/sdeTypes.ts) working unchanged. Access model is inherited from
-- the existing view (security_invoker over the public-read sde_* tables), so no
-- new grants are needed.
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
  (t.data ->> 'volume')::double precision as volume
from public.sde_types t
left join public.sde_groups g on g._key = (t.data ->> 'groupID')::bigint
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint
where (t.data ->> 'published')::boolean
  and coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';
