-- breadcrumb (/asset/[locationId], /ship/[itemId]): the materialized path of
-- one item — the item itself, then each enclosing container outward, ordered
-- by depth. The last row's location_id/location_type is the root place (a
-- station, structure or solar system that isn't one of the caller's items).
-- Climbs the live character_asset ∪ corp_asset views, so RLS scopes every
-- hop to the caller; a parent the caller can't see just ends the walk early.
-- Seeded from a single item (like the *_asset_search functions), so it stays
-- cheap regardless of hangar size.
create or replace function public.asset_ancestors(start_id bigint)
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int)
language sql
stable
as $$
  with recursive parent_of as (
    select item_id, type_id, name, location_id, location_type
    from public.character_asset
    union all
    select item_id, type_id, null::text as name, location_id, location_type
    from public.corp_asset
  ),
  walk as (
    select p.item_id, p.type_id, p.name, p.location_id, p.location_type, 1 as depth
    from parent_of p
    where p.item_id = start_id
    union all
    select p.item_id, p.type_id, p.name, p.location_id, p.location_type, w.depth + 1
    from walk w
    join parent_of p on p.item_id = w.location_id
    where w.depth < 16
  )
  select * from walk order by depth;
$$;

grant execute on function public.asset_ancestors(bigint) to authenticated;
