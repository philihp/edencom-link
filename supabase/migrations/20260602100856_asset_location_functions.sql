-- Asset location aggregation functions.
--
-- Items nest (a module in a ship in a station), so the assets UI used to page
-- every live asset into Node and walk the location_id chains there — tens of
-- thousands of rows per request, which timed the pages out. These do the walk
-- in Postgres instead and return only the aggregate each page needs. Both are
-- SECURITY INVOKER (the default), so the asset view's RLS still scopes every
-- read to the caller's own characters. The depth caps guard against cycles.
--
-- This migration is non-destructive (create or replace) and is mirrored in
-- schema.sql, which remains the canonical full-reset snapshot of the schema.

-- assets index (/assets): for every root location (a station, structure or
-- solar system that isn't itself one of our items), the number of item stacks
-- there, split by the character that owns each stack. Each asset is climbed up
-- its location_id chain through items we also own until the parent isn't ours;
-- that parent is the root.
create or replace function public.asset_location_summary()
returns table (location_id bigint, location_type text, character_id uuid, stacks bigint)
language sql
stable
as $$
  with recursive walk as (
    select
      a.item_id       as start_item,
      a.character_id  as character_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.asset a
    union all
    select
      w.start_item,
      w.character_id,
      p.location_id,
      p.location_type,
      w.depth + 1
    from walk w
    join public.asset p on p.item_id = w.location_id
    where w.depth < 64
  )
  select
    w.location_id,
    w.location_type,
    w.character_id,
    count(*) as stacks
  from walk w
  where w.location_id is not null
    and not exists (select 1 from public.asset o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.character_id;
$$;

-- per-location page (/assets/[locationId]): for each item sitting directly in
-- `parent`, the number of items nested inside it (the whole subtree, excluding
-- the item itself).
create or replace function public.asset_location_contents(parent bigint)
returns table (item_id bigint, contents bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id as root_child, a.item_id as node, 1 as depth
    from public.asset a
    where a.location_id = parent
    union all
    select d.root_child, c.item_id, d.depth + 1
    from descend d
    join public.asset c on c.location_id = d.node
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

grant execute on function public.asset_location_summary()        to authenticated;
grant execute on function public.asset_location_contents(bigint) to authenticated;
