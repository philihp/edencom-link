-- The assets pages now show corporation assets alongside character assets.
-- Mirror the per-character location-walk functions over the corp asset SCD-2
-- history so the index and per-location pages can aggregate corp hangars in
-- Postgres too (paging every asset into Node and walking the chains there is
-- what timed the character pages out). Both are SECURITY INVOKER, so the RLS
-- on corp_asset / corp_asset_over_time keeps reads scoped to corporations the
-- caller has a registered character in.

-- assets index (/asset): for every root location (a station, structure or
-- solar system that isn't itself one of the corp's items), the number of item
-- stacks there, split by the corporation that owns each stack. Corp assets
-- nest through office folders and containers the same way character assets
-- nest through ships, so the same recursive climb applies.
create or replace function public.corp_asset_location_summary()
returns table (location_id bigint, location_type text, corporation_id bigint, stacks bigint)
language sql
stable
as $$
  with recursive parent_of as (
    -- One best-known parent per item the caller can see: the live row if there
    -- is one, otherwise the most recent historical sighting, so the walk can
    -- bridge a container that momentarily dropped out of the current snapshot.
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    order by item_id, is_current desc, last_seen_at desc
  ),
  walk as (
    select
      a.item_id        as start_item,
      a.corporation_id as corporation_id,
      a.location_id    as location_id,
      a.location_type  as location_type,
      1                as depth
    from public.corp_asset a
    union all
    select
      w.start_item,
      w.corporation_id,
      p.location_id,
      p.location_type,
      w.depth + 1
    from walk w
    join parent_of p on p.item_id = w.location_id
    where w.depth < 64
  )
  select
    w.location_id,
    w.location_type,
    w.corporation_id,
    count(*) as stacks
  from walk w
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.corporation_id;
$$;

-- per-location page (/asset/[locationId]): for each corp item sitting directly
-- in `parent`, the number of items nested inside it (the whole subtree,
-- excluding the item itself).
create or replace function public.corp_asset_location_contents(parent bigint)
returns table (item_id bigint, contents bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id as root_child, a.item_id as node, 1 as depth
    from public.corp_asset a
    where a.location_id = parent
    union all
    select d.root_child, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset c on c.location_id = d.node
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

grant execute on function public.corp_asset_location_summary()        to authenticated;
grant execute on function public.corp_asset_location_contents(bigint) to authenticated;
