-- /asset/search shows each match's immediate "hangar" (its location_flag, e.g.
-- HiSlot4 / MedSlot1 for a fitted module). A slot flag means the item is on a
-- ship, but the search never surfaced *which* ship. Extend both search RPCs to
-- also return the matched item's immediate parent — its item id, type, and
-- (character only) player-assigned name — so the page can resolve a fitted
-- item's ship and link to it. parent_* is null when the immediate parent isn't
-- one of the caller's items (e.g. the item sits directly in a station).
--
-- This builds on 20260721010000_sde_name_joins.sql, which added the
-- type_name / root_location_name / system_id columns to these same functions;
-- both column sets are preserved here. Adding columns changes the RETURNS TABLE
-- signature, which create-or-replace can't do — drop first (which discards
-- grants), recreate with the wider result, then re-grant.

drop function if exists public.character_asset_search(bigint[]) cascade;
create function public.character_asset_search(type_ids bigint[])
returns table (
  item_id bigint,
  character_id uuid,
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
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  matched as (
    select a.item_id, a.character_id, a.type_id, a.quantity, a.is_singleton, a.name,
           a.location_flag, a.location_id, a.location_type
    from public.character_asset a
    where a.type_id = any(type_ids)
  ),
  climb as (
    select m.item_id as start_item, m.location_id, m.location_type, 1 as depth
    from matched m
    union all
    select c.start_item, p.location_id, p.location_type, c.depth + 1
    from climb c
    join parent_of p on p.item_id = c.location_id
    where c.depth < 64
  ),
  roots as (
    select w.start_item, w.location_id as root_location_id, w.location_type as root_location_type
    from climb w
    where w.location_id is not null
      and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.node
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(*) - 1 as contents
    from descend
    group by ancestor
  )
  select
    m.item_id,
    m.character_id,
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
  left join public.character_asset p on p.item_id = m.location_id;
$$;
grant execute on function public.character_asset_search(bigint[]) to authenticated;

drop function if exists public.corp_asset_search(bigint[]) cascade;
create function public.corp_asset_search(type_ids bigint[])
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
  parent_type_id bigint
)
language sql
stable
as $$
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  matched as (
    select a.item_id, a.corporation_id, a.type_id, a.quantity, a.is_singleton,
           a.location_flag, a.location_id, a.location_type
    from public.corp_asset a
    where a.type_id = any(type_ids)
  ),
  climb as (
    select m.item_id as start_item, m.location_id, m.location_type, 1 as depth
    from matched m
    union all
    select c.start_item, p.location_id, p.location_type, c.depth + 1
    from climb c
    join parent_of p on p.item_id = c.location_id
    where c.depth < 64
  ),
  roots as (
    select w.start_item, w.location_id as root_location_id, w.location_type as root_location_type
    from climb w
    where w.location_id is not null
      and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset c on c.location_id = d.node
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
    p.type_id as parent_type_id
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.corp_asset p on p.item_id = m.location_id;
$$;
grant execute on function public.corp_asset_search(bigint[]) to authenticated;
