-- Time travel for the MCP asset tools (search_assets, list_assets,
-- browse_assets): the same answers as character_asset_filter() /
-- corp_asset_filter() / *_asset_location_summary(), reconstructed as the
-- hangars stood at `as_of` from the SCD-2 history.
--
-- Separate functions rather than an `as_of default null` on the live ones, for
-- the reason market_price_snapshot() keeps its two branches apart: the live
-- path is `is_current` and reaches the current-only partial indexes, and
-- folding a time-travel OR into its predicates would cost every live call
-- those indexes.
--
-- A version is in effect at `as_of` when it had started by then and was still
-- open, or closed no earlier than then — the predicate the *_snapshot_at
-- functions use. It is spelled
--
--   valid_from <= as_of and (is_current or (not is_current and valid_until >= as_of))
--
-- so each arm of the OR implies one of the two partial location indexes (the
-- current one and the closed-rows history one), and a "children of this item"
-- probe reaches an index either way.
--
-- The owner scope is a required argument, not left to RLS alone. The
-- "Audience reads shared assets" policy on character_asset_version ORs an
-- asset_share_covers() call with the ownership test, which keeps the
-- registration_id index out of any plan that leaves owners to RLS; a scan of
-- the version table that way runs ~2.3s and calls the share walk on every
-- current row of every account. `registration_id = any($1)` is leakproof, so
-- it is applied first and through the index; RLS still checks what it finds,
-- so naming someone else's registration returns nothing. Share recipients
-- get nothing from history anyway (that policy covers current rows only), so
-- time travel is over the caller's own hangars.
--
-- A parent is followed to its version in effect at `as_of`, else the latest
-- one that had started by then, else its newest — the best-known parent, the
-- way the live climb bridges a container that has dropped out of a snapshot.
-- An item whose climb stops at a parent the caller cannot see keeps that
-- parent's id as its root (location_type 'item') rather than vanishing.

-- The corp table has no index for "children of this item" among closed rows
-- (the character table's twin is history_location_idx); the descent below
-- needs one. Partial on closed rows, so an insert never writes it.
create index if not exists corp_asset_over_time_history_location_idx
  on public.corp_asset_over_time (location_id, valid_until desc)
  where not is_current;

create or replace function public.character_asset_filter_at(
  registration_ids uuid[],
  as_of timestamptz,
  type_ids bigint[] default null,
  location_ids bigint[] default null
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
    -- Items directly at a named location: a parent link to it (a container
    -- or ship of ours) or a place there (a station, structure, system).
    select v.item_id, 1 as depth
    from public.character_asset_version v
    where coalesce(cardinality(location_ids), 0) > 0
      and v.location_id = any(location_ids)
      and v.valid_from <= as_of
      and (v.is_current or (not v.is_current and v.valid_until >= as_of))
    union all
    select v.item_id, 1 as depth
    from public.character_asset_location l
    join public.character_asset_version v on v.id = l.asset_id
    where coalesce(cardinality(location_ids), 0) > 0
      and l.location_id = any(location_ids)
      and v.valid_from <= as_of
      and (v.is_current or (not v.is_current and v.valid_until >= as_of))
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.character_asset_version c
      on c.location_id = i.item_id
     and c.valid_from <= as_of
     and (c.is_current or (not c.is_current and c.valid_until >= as_of))
    where i.depth < 64
  ),
  -- One version per item: at a boundary instant a closed row and its
  -- successor can both qualify, and the later one wins.
  matched as (
    select distinct on (v.item_id)
           v.id, v.item_id, v.registration_id, v.type_id, v.quantity, v.is_singleton, v.name,
           v.location_id as link_id,
           coalesce(v.location_id, l.location_id) as location_id,
           coalesce(v.location_flag, l.location_flag) as location_flag
    from public.character_asset_version v
    left join public.character_asset_location l on l.asset_id = v.id
    where v.registration_id = any(registration_ids)
      and v.valid_from <= as_of
      and (v.is_current or (not v.is_current and v.valid_until >= as_of))
      and (coalesce(cardinality(type_ids), 0) = 0 or v.type_id = any(type_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or v.item_id in (select i.item_id from inside i))
    order by v.item_id, v.valid_from desc
  ),
  -- Climb to the top of each tree. A row whose link is null is the end of
  -- its climb: either a root item (version_id set; its place is in the
  -- location table) or a parent no version of which is visible (version_id
  -- null; stuck_at holds the parent's id).
  climb as (
    select m.item_id as start_item, m.id as version_id, m.link_id, null::bigint as stuck_at, 1 as depth
    from matched m
    union all
    select c.start_item, p.id, p.location_id, case when p.id is null then c.link_id end, c.depth + 1
    from climb c
    left join lateral (
      select pv.id, pv.location_id
      from public.character_asset_version pv
      where pv.item_id = c.link_id
      order by (pv.valid_from <= as_of and (pv.is_current or pv.valid_until >= as_of)) desc,
               (pv.valid_from <= as_of) desc,
               pv.valid_from desc
      limit 1
    ) p on true
    where c.link_id is not null
      and c.depth < 64
  ),
  roots as (
    select c.start_item,
           coalesce(l.location_id, c.stuck_at) as root_location_id,
           case when c.version_id is null then 'item' else l.location_type end as root_location_type
    from climb c
    left join public.character_asset_location l on l.asset_id = c.version_id
    where c.link_id is null
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.character_asset_version c
      on c.location_id = d.node
     and c.valid_from <= as_of
     and (c.is_current or (not c.is_current and c.valid_until >= as_of))
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(distinct node) - 1 as contents
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
  left join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join lateral (
    select pv.type_id, pv.name
    from public.character_asset_version pv
    where pv.item_id = m.link_id
    order by (pv.valid_from <= as_of and (pv.is_current or pv.valid_until >= as_of)) desc,
             (pv.valid_from <= as_of) desc,
             pv.valid_from desc
    limit 1
  ) p on true;
$$;

-- The corp mirror. Corp rows keep their location in-row (no place table), and
-- there is no custom name column, so the two name columns are absent.
create or replace function public.corp_asset_filter_at(
  corporation_ids bigint[],
  as_of timestamptz,
  type_ids bigint[] default null,
  location_ids bigint[] default null
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
  parent_type_id bigint
)
language sql
stable
as $$
  with recursive inside as (
    select a.item_id, 1 as depth
    from public.corp_asset_over_time a
    where coalesce(cardinality(location_ids), 0) > 0
      and a.location_id = any(location_ids)
      and a.valid_from <= as_of
      and (a.is_current or (not a.is_current and a.valid_until >= as_of))
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.corp_asset_over_time c
      on c.location_id = i.item_id
     and c.valid_from <= as_of
     and (c.is_current or (not c.is_current and c.valid_until >= as_of))
    where i.depth < 64
  ),
  matched as (
    select distinct on (a.item_id)
           a.item_id, a.corporation_id, a.type_id, a.quantity, a.is_singleton,
           a.location_flag, a.location_id, a.location_type
    from public.corp_asset_over_time a
    where a.corporation_id = any(corporation_ids)
      and a.valid_from <= as_of
      and (a.is_current or (not a.is_current and a.valid_until >= as_of))
      and (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or a.item_id in (select i.item_id from inside i))
    order by a.item_id, a.valid_from desc
  ),
  climb as (
    select m.item_id as start_item, m.location_id, m.location_type, 1 as depth
    from matched m
    union all
    select c.start_item, p.location_id, p.location_type, c.depth + 1
    from climb c
    cross join lateral (
      select pv.location_id, pv.location_type
      from public.corp_asset_over_time pv
      where pv.item_id = c.location_id
      order by (pv.valid_from <= as_of and (pv.is_current or pv.valid_until >= as_of)) desc,
               (pv.valid_from <= as_of) desc,
               pv.valid_from desc
      limit 1
    ) p
    where c.location_id is not null
      and c.depth < 64
  ),
  -- The top of a climb is the one location that is no corp item at all.
  roots as (
    select c.start_item, c.location_id as root_location_id, c.location_type as root_location_type
    from climb c
    where c.location_id is not null
      and not exists (select 1 from public.corp_asset_over_time o where o.item_id = c.location_id)
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset_over_time c
      on c.location_id = d.node
     and c.valid_from <= as_of
     and (c.is_current or (not c.is_current and c.valid_until >= as_of))
    where d.depth < 64
  ),
  contents as (
    select ancestor, count(distinct node) - 1 as contents
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
  left join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join lateral (
    select pv.type_id
    from public.corp_asset_over_time pv
    where pv.item_id = m.location_id
    order by (pv.valid_from <= as_of and (pv.is_current or pv.valid_until >= as_of)) desc,
             (pv.valid_from <= as_of) desc,
             pv.valid_from desc
    limit 1
  ) p on true;
$$;

-- browse_assets' list of places at `as_of`: stacks per root location per
-- owner, the shape of *_asset_location_summary(), over the same snapshot
-- and climb as the filters above. Every stack counts once, wherever it is
-- nested.
create or replace function public.character_asset_location_summary_at(registration_ids uuid[], as_of timestamptz)
returns table (location_id bigint, location_type text, registration_id uuid, stacks bigint, station_name text, system_id bigint)
language sql
stable
as $$
  select f.root_location_id, f.root_location_type, f.registration_id, count(*) as stacks,
         min(f.root_location_name) as station_name, min(f.system_id) as system_id
  from public.character_asset_filter_at(registration_ids, as_of) f
  where f.root_location_id is not null
  group by f.root_location_id, f.root_location_type, f.registration_id;
$$;

create or replace function public.corp_asset_location_summary_at(corporation_ids bigint[], as_of timestamptz)
returns table (location_id bigint, location_type text, corporation_id bigint, stacks bigint, station_name text, system_id bigint)
language sql
stable
as $$
  select f.root_location_id, f.root_location_type, f.corporation_id, count(*) as stacks,
         min(f.root_location_name) as station_name, min(f.system_id) as system_id
  from public.corp_asset_filter_at(corporation_ids, as_of) f
  where f.root_location_id is not null
  group by f.root_location_id, f.root_location_type, f.corporation_id;
$$;

grant execute on function public.character_asset_filter_at(uuid[], timestamptz, bigint[], bigint[])  to authenticated;
grant execute on function public.corp_asset_filter_at(bigint[], timestamptz, bigint[], bigint[])      to authenticated;
grant execute on function public.character_asset_location_summary_at(uuid[], timestamptz)             to authenticated;
grant execute on function public.corp_asset_location_summary_at(bigint[], timestamptz)                to authenticated;
