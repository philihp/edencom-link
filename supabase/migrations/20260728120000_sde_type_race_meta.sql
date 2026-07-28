-- Extend sde_published_type with the two columns the /fitting ship matrix
-- sorts hulls by: race_id (which empire's line a hull belongs to — Caldari 1,
-- Minmatar 2, Amarr 4, Gallente 8; pirate/ORE/SoCT lines carry other ids) and
-- meta_group_id (Tech I 1, Tech II 2, Storyline 3, Faction 4, Tech III 14, …;
-- absent in the SDE for plain T1 types, so nullable).
--
-- Same replacement rules as 20260723000000_sde_taxonomy_views.sql: the new
-- columns are appended at the END of the select — create-or-replace requires
-- it, and it keeps existing consumers (the sde_search_type RPC, the
-- sde_name_joins functions, src/sdeTypes.ts) working unchanged. Access model
-- is inherited from the existing view (security_invoker over the public-read
-- sde_* tables), so no new grants are needed.
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
  (t.data ->> 'metaGroupID')::bigint as meta_group_id
from public.sde_types t
left join public.sde_groups g on g._key = (t.data ->> 'groupID')::bigint
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint
where (t.data ->> 'published')::boolean
  and coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';
