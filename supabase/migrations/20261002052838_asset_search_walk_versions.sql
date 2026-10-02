-- character_asset_search() and character_asset_filter() timed out for every
-- signed-in caller, so search_assets, list_assets and /asset/search showed no
-- character items at all (zero Mykoserocin where 1,723 sat in a structure).
--
-- Both found an item's root through a parent_of CTE: a DISTINCT ON over the
-- whole character_asset_over_time view, every version row of every account
-- (431,065 rows), sorted on disk. As postgres that took 2.2 s. As
-- authenticated, RLS checks each of those rows, and the "Audience reads
-- shared assets" policy calls asset_share_covers() for each current row, so
-- the call ran past the role's 8 s statement_timeout and was cancelled.
--
-- The walk now climbs the version table directly, one indexed lookup per
-- step (recursive walks join character_asset_version, never the view), and
-- reads the root's place from character_asset_location. RLS then checks only
-- the rows the walk touches. Measured as the reporting user under the same
-- 8 s timeout: 141 ms, every matched stack rooted.
--
-- Same signatures and output columns, so create or replace is enough.

create or replace function public.character_asset_search(type_ids bigint[])
returns table (
  item_id bigint,
  registration_id uuid,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  name text,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint,
  type_name text,
  root_location_name text,
  system_id bigint,
  parent_id bigint,
  parent_type_id bigint,
  parent_name text
)
language sql
stable
as $$
  with recursive matched as (
    select a.item_id, a.registration_id, a.type_id, a.quantity, a.is_singleton, a.name,
           a.location_flag, a.location_id, a.location_type
    from public.character_asset a
    where a.type_id = any(type_ids)
  ),
  -- Walk up from each matched item to the top of its tree, one indexed
  -- lookup per step on the version table: a parent link names another
  -- asset, so the step reads that asset's newest version row (its open one,
  -- else the last closed one). The walk stops at a row with no parent link,
  -- a root item, and roots reads that row's place from the location table.
  climb as (
    select m.item_id as start_item, v.id as version_id, v.location_id, 1 as depth
    from matched m
    join public.character_asset_version v on v.item_id = m.item_id and v.is_current
    union all
    select c.start_item, p.id, p.location_id, c.depth + 1
    from climb c
    cross join lateral (
      select pv.id, pv.location_id
      from public.character_asset_version pv
      where pv.item_id = c.location_id
      order by pv.is_current desc, pv.valid_until desc
      limit 1
    ) p
    where c.location_id is not null
      and c.depth < 64
  ),
  roots as (
    select c.start_item, l.location_id as root_location_id, l.location_type as root_location_type
    from climb c
    join public.character_asset_location l on l.asset_id = c.version_id
    where c.location_id is null
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.character_asset_version c on c.location_id = d.node and c.is_current
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.registration_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.name,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents,
    t.name as type_name,
    st.name as root_location_name,
    st.system_id,
    m.location_id as parent_id,
    p.type_id as parent_type_id,
    p.name as parent_name
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.character_asset_version p on p.item_id = m.location_id and p.is_current;
$$;

create or replace function public.character_asset_filter(
  type_ids bigint[] default null,
  location_ids bigint[] default null,
  registration_ids uuid[] default null
)
returns table (
  item_id bigint,
  registration_id uuid,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  name text,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint,
  type_name text,
  root_location_name text,
  system_id bigint,
  parent_id bigint,
  parent_type_id bigint,
  parent_name text
)
language sql
stable
as $$
  with recursive inside as (
    select a.item_id, 1 as depth
    from public.character_asset a
    where coalesce(cardinality(location_ids), 0) > 0
      and a.location_id = any(location_ids)
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.character_asset_version c on c.location_id = i.item_id and c.is_current
    where i.depth < 64
  ),
  matched as (
    select a.item_id, a.registration_id, a.type_id, a.quantity, a.is_singleton, a.name,
           a.location_flag, a.location_id, a.location_type
    from public.character_asset a
    where (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
      and (coalesce(cardinality(registration_ids), 0) = 0 or a.registration_id = any(registration_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or a.item_id in (select i.item_id from inside i))
  ),
  -- Walk up from each matched item to the top of its tree, one indexed
  -- lookup per step on the version table: a parent link names another
  -- asset, so the step reads that asset's newest version row (its open one,
  -- else the last closed one). The walk stops at a row with no parent link,
  -- a root item, and roots reads that row's place from the location table.
  climb as (
    select m.item_id as start_item, v.id as version_id, v.location_id, 1 as depth
    from matched m
    join public.character_asset_version v on v.item_id = m.item_id and v.is_current
    union all
    select c.start_item, p.id, p.location_id, c.depth + 1
    from climb c
    cross join lateral (
      select pv.id, pv.location_id
      from public.character_asset_version pv
      where pv.item_id = c.location_id
      order by pv.is_current desc, pv.valid_until desc
      limit 1
    ) p
    where c.location_id is not null
      and c.depth < 64
  ),
  roots as (
    select c.start_item, l.location_id as root_location_id, l.location_type as root_location_type
    from climb c
    join public.character_asset_location l on l.asset_id = c.version_id
    where c.location_id is null
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.character_asset_version c on c.location_id = d.node and c.is_current
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.registration_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.name,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents,
    t.name as type_name,
    st.name as root_location_name,
    st.system_id,
    m.location_id as parent_id,
    p.type_id as parent_type_id,
    p.name as parent_name
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.character_asset_version p on p.item_id = m.location_id and p.is_current;
$$;
