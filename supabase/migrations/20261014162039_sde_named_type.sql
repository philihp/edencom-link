-- Every named type, published or not, for by-id name lookups.
--
-- sde_published_type is the right cut for search and pickers, but an asset can
-- be a type CCP never published: the corp Office (27) every corp hangar hangs
-- off, Asset Safety Wrap (60), Cargo Container (23), wrecks, expired boosters
-- and filaments, ship modes. Resolving names through the published view left
-- those rows as a bare "#27". This view is the same shape minus the
-- `published` filter; src/sdeTypes.ts getSdeTypes reads it, while search
-- (sde_search_type) and the group listing stay published-only.
create or replace view public.sde_named_type
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
where coalesce(trim(t.data -> 'name' ->> 'en'), '') <> '';

grant select on public.sde_named_type to anon, authenticated, service_role;
revoke insert, update, delete on public.sde_named_type from anon, authenticated;
