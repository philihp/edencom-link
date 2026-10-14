-- MCP search_assets / list_assets: an opt-in `include_shared` on the four live
-- asset lookups, default false.
--
-- RLS already lets an asset share's rows through character_asset/corp_asset,
-- so these functions always *saw* items shared with the caller — and dropped
-- them, because the final inner join to `roots` needs the item's root place,
-- which lives in the owner-only character_asset_location (members-only
-- corp_asset_location) and so never reaches a recipient. Leaving shared items
-- out was the intended answer, but it held only as a side effect of that join.
--
-- Now it is explicit: by default a row is kept only when the caller owns it
-- (one of their registrations, one of their corporations), whatever RLS lets
-- through. With include_shared, a row someone else owns is kept too, and its
-- root place comes back null — the recipient may see the item, never where it
-- is. `shared` says which rows those are.
--
-- An owner filter narrows only the caller's own rows: the ids a caller can name
-- are their own characters and corporations, so shared rows ride along on the
-- side being queried (the GraphQL `assets(includeShared:)` rule). The caller
-- decides which sides run at all.
--
-- The signatures change (a new argument, a new column), so each function is
-- dropped and recreated; every caller passes arguments by name, and the new
-- argument defaults to the old behaviour. The *_filter_at history functions
-- are untouched: shares cover current rows only.

drop function if exists public.character_asset_search(bigint[]);
drop function if exists public.character_asset_filter(bigint[], bigint[], uuid[]);
drop function if exists public.corp_asset_search(bigint[]);
drop function if exists public.corp_asset_filter(bigint[], bigint[], bigint[]);

create function public.character_asset_search(type_ids bigint[], include_shared boolean default false)
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
  parent_name text,
  shared boolean
)
language sql
stable
as $$
  with recursive mine as (
    select r.id from public.registration r where r.user_id = (select auth.uid())
  ),
  matched as (
    select a.item_id, a.registration_id, a.type_id, a.quantity, a.is_singleton, a.name,
           a.location_flag, a.location_id, a.location_type,
           a.registration_id not in (select id from mine) as shared
    from public.character_asset a
    where a.type_id = any(type_ids)
      and (include_shared or a.registration_id in (select id from mine))
  ),
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
    p.name as parent_name,
    m.shared
  from matched m
  left join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.character_asset_version p on p.item_id = m.location_id and p.is_current
  where r.start_item is not null or m.shared;
$$;

create function public.character_asset_filter(
  type_ids bigint[] default null,
  location_ids bigint[] default null,
  registration_ids uuid[] default null,
  include_shared boolean default false
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
  parent_name text,
  shared boolean
)
language sql
stable
as $$
  with recursive mine as (
    select r.id from public.registration r where r.user_id = (select auth.uid())
  ),
  inside as (
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
           a.location_flag, a.location_id, a.location_type,
           a.registration_id not in (select id from mine) as shared
    from public.character_asset a
    where (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or a.item_id in (select i.item_id from inside i))
      and (
        (a.registration_id in (select id from mine)
          and (coalesce(cardinality(registration_ids), 0) = 0 or a.registration_id = any(registration_ids)))
        or (include_shared and a.registration_id not in (select id from mine))
      )
  ),
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
    p.name as parent_name,
    m.shared
  from matched m
  left join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.character_asset_version p on p.item_id = m.location_id and p.is_current
  where r.start_item is not null or m.shared;
$$;

create function public.corp_asset_search(type_ids bigint[], include_shared boolean default false)
returns table (
  item_id bigint,
  corporation_id bigint,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint,
  type_name text,
  root_location_name text,
  system_id bigint,
  parent_id bigint,
  parent_type_id bigint,
  shared boolean
)
language sql
stable
as $$
  with recursive mine as (
    select public.my_corporation_ids() as corporation_id
  ),
  matched as (
    select a.item_id, a.corporation_id, a.type_id, a.quantity, a.is_singleton,
           a.location_flag, a.location_id, a.location_type,
           a.corporation_id not in (select corporation_id from mine) as shared
    from public.corp_asset a
    where a.type_id = any(type_ids)
      and (include_shared or a.corporation_id in (select corporation_id from mine))
  ),
  climb as (
    select m.item_id as start_item, v.id as version_id, v.location_id, 1 as depth
    from matched m
    join public.corp_asset_version v on v.item_id = m.item_id and v.is_current
    union all
    select c.start_item, p.id, p.location_id, c.depth + 1
    from climb c
    cross join lateral (
      select pv.id, pv.location_id
      from public.corp_asset_version pv
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
    join public.corp_asset_location l on l.asset_id = c.version_id
    where c.location_id is null
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset_version c on c.location_id = d.node and c.is_current
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.corporation_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents,
    t.name as type_name,
    st.name as root_location_name,
    st.system_id,
    m.location_id as parent_id,
    p.type_id as parent_type_id,
    m.shared
  from matched m
  left join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.corp_asset_version p on p.item_id = m.location_id and p.is_current
  where r.start_item is not null or m.shared;
$$;

create function public.corp_asset_filter(
  type_ids bigint[] default null,
  location_ids bigint[] default null,
  corporation_ids bigint[] default null,
  include_shared boolean default false
)
returns table (
  item_id bigint,
  corporation_id bigint,
  type_id bigint,
  quantity bigint,
  is_singleton boolean,
  location_flag text,
  root_location_id bigint,
  root_location_type text,
  contents bigint,
  type_name text,
  root_location_name text,
  system_id bigint,
  parent_id bigint,
  parent_type_id bigint,
  shared boolean
)
language sql
stable
as $$
  with recursive mine as (
    select public.my_corporation_ids() as corporation_id
  ),
  inside as (
    select a.item_id, 1 as depth
    from public.corp_asset a
    where coalesce(cardinality(location_ids), 0) > 0
      and a.location_id = any(location_ids)
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.corp_asset_version c on c.location_id = i.item_id and c.is_current
    where i.depth < 64
  ),
  matched as (
    select a.item_id, a.corporation_id, a.type_id, a.quantity, a.is_singleton,
           a.location_flag, a.location_id, a.location_type,
           a.corporation_id not in (select corporation_id from mine) as shared
    from public.corp_asset a
    where (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or a.item_id in (select i.item_id from inside i))
      and (
        (a.corporation_id in (select corporation_id from mine)
          and (coalesce(cardinality(corporation_ids), 0) = 0 or a.corporation_id = any(corporation_ids)))
        or (include_shared and a.corporation_id not in (select corporation_id from mine))
      )
  ),
  climb as (
    select m.item_id as start_item, v.id as version_id, v.location_id, 1 as depth
    from matched m
    join public.corp_asset_version v on v.item_id = m.item_id and v.is_current
    union all
    select c.start_item, p.id, p.location_id, c.depth + 1
    from climb c
    cross join lateral (
      select pv.id, pv.location_id
      from public.corp_asset_version pv
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
    join public.corp_asset_location l on l.asset_id = c.version_id
    where c.location_id is null
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset_version c on c.location_id = d.node and c.is_current
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.corporation_id,
    m.type_id,
    m.quantity,
    m.is_singleton,
    m.location_flag,
    r.root_location_id,
    r.root_location_type,
    coalesce(ct.contents, 0) as contents,
    t.name as type_name,
    st.name as root_location_name,
    st.system_id,
    m.location_id as parent_id,
    p.type_id as parent_type_id,
    m.shared
  from matched m
  left join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.corp_asset_version p on p.item_id = m.location_id and p.is_current
  where r.start_item is not null or m.shared;
$$;

grant execute on function public.character_asset_search(bigint[], boolean)                    to authenticated;
grant execute on function public.character_asset_filter(bigint[], bigint[], uuid[], boolean)  to authenticated;
grant execute on function public.corp_asset_search(bigint[], boolean)                         to authenticated;
grant execute on function public.corp_asset_filter(bigint[], bigint[], bigint[], boolean)     to authenticated;

notify pgrst, 'reload schema';
