-- character_asset_within / corp_asset_within — the GraphQL `assets` and
-- `restock` lists (and so every Data Link over them) with a location or hangar
-- filter that follows each item's parent chain.
--
-- Until now those filters compared each row's OWN location_id and
-- location_flag. An item in a container has the container as its location and
-- a container-content flag, so a corporation's "everything in HFC-AQ, hangars
-- 3 and 4" lost every item inside a container there. Corp hangars lost even
-- more: an item in a hangar division sits in the corporation's Office, so a
-- structure's id matched the Office and nothing in it.
--
-- Here both filters are containment filters, the same reading the MCP
-- list_assets location filter already has (character_asset_filter()):
--
--   - location_ids: an item matches when it sits in one of the places, or
--     anywhere inside a container, ship or Office that does. A SOLAR SYSTEM id
--     also names every NPC station and player structure in that system, so
--     "HFC-AQ" is everything there, not only what floats in space. An item id
--     names that container's contents (never the container itself).
--   - include_flags: an item matches when its own hangar, or the hangar of any
--     container above it, is one of these. A container in CorpSAG3 brings
--     everything inside it.
--   - exclude_flags: an item is dropped when its own hangar, or the hangar of
--     any container above it, is one of these. A stack in no hangar survives.
--
-- Nothing is stored: each call walks down from the rows a filter names to their
-- current children, so a new container is in the result the next time the
-- assets extract sees it, and a container moved out takes its contents out
-- with it.
--
-- The walk follows the rules of the security-invoker character_asset /
-- corp_asset views it stands beside: a root takes its place and hangar from
-- the location table, any other item counts only through a parent row the
-- caller can see, and the descent runs through current version rows. A share
-- recipient reads no place and no hidden parent link, so a filter reaches a
-- shared item only through the links inside the shared tree. The walk reads
-- the tables through their indexes rather than reading the view: a filter that
-- names a structure or a hangar visits that subtree, not the whole hangar.
-- Only an exclusion with nothing included reads every row, as it must.
--
-- THE OWNER LIST IS REQUIRED and every seed and every returned row is filtered
-- by it. In session mode that repeats RLS; on a Data Link, which runs on the
-- service-role client under its creator's ids, it is the leak guard. A child
-- row always has the owner of its parent, so the descent stays inside it.
--
-- Returns one json object — {"total": n, "rows": [...]} — with `total` over the
-- whole filtered set and at most `row_limit` rows ordered by item_id, so the
-- walk runs once per call rather than once per PostgREST page.
create or replace function public.character_asset_within(
  registration_ids uuid[],
  type_ids bigint[] default null,
  location_ids bigint[] default null,
  include_flags text[] default null,
  exclude_flags text[] default null,
  row_limit int default 5000
)
returns json
language sql
stable
-- The planner cannot size a recursive walk, so it guesses millions of rows,
-- prices the query past jit_above_cost, and spends about a second compiling a
-- plan that runs in a tenth of that.
set jit = off
as $$
  with recursive
  -- The places the location filter names: the ids themselves, and for a solar
  -- system every NPC station and player structure in it.
  places as (
    select unnest(location_ids) as place_id
    union
    select st.station_id
    from public.sde_station st
    where coalesce(cardinality(location_ids), 0) > 0
      and st.system_id = any(location_ids)
    union
    select cs.structure_id
    from public.corp_structure cs
    where coalesce(cardinality(location_ids), 0) > 0
      and cs.system_id = any(location_ids)
    union
    select us.structure_id
    from public.universe_structure us
    where coalesce(cardinality(location_ids), 0) > 0
      and us.system_id = any(location_ids)
  ),
  -- Where each walk starts: a root whose place (or hangar) the filter names,
  -- read from the location table, and any other item whose parent (or own
  -- hangar) it names, counted only when that parent has a current row the
  -- caller can see.
  inside_seeds as (
    select v.item_id
    from public.character_asset_location l
    join public.character_asset_version v on v.id = l.asset_id and v.is_current and v.location_id is null
    where coalesce(cardinality(location_ids), 0) > 0
      and v.registration_id = any(registration_ids)
      and l.location_id in (select p.place_id from places p)
    union all
    select v.item_id
    from public.character_asset_version v
    where coalesce(cardinality(location_ids), 0) > 0
      and v.is_current
      and v.registration_id = any(registration_ids)
      and v.location_id in (select p.place_id from places p)
      and exists (select 1 from public.character_asset_version pv where pv.item_id = v.location_id and pv.is_current)
  ),
  included_seeds as (
    select v.item_id
    from public.character_asset_location l
    join public.character_asset_version v on v.id = l.asset_id and v.is_current and v.location_id is null
    where coalesce(cardinality(include_flags), 0) > 0
      and v.registration_id = any(registration_ids)
      and l.location_flag = any(include_flags)
    union all
    select v.item_id
    from public.character_asset_version v
    where coalesce(cardinality(include_flags), 0) > 0
      and v.is_current
      and v.registration_id = any(registration_ids)
      and v.location_flag = any(include_flags)
      and exists (select 1 from public.character_asset_version pv where pv.item_id = v.location_id and pv.is_current)
  ),
  excluded_seeds as (
    select v.item_id
    from public.character_asset_location l
    join public.character_asset_version v on v.id = l.asset_id and v.is_current and v.location_id is null
    where coalesce(cardinality(exclude_flags), 0) > 0
      and v.registration_id = any(registration_ids)
      and l.location_flag = any(exclude_flags)
    union all
    select v.item_id
    from public.character_asset_version v
    where coalesce(cardinality(exclude_flags), 0) > 0
      and v.is_current
      and v.registration_id = any(registration_ids)
      and v.location_flag = any(exclude_flags)
      and exists (select 1 from public.character_asset_version pv where pv.item_id = v.location_id and pv.is_current)
  ),
  -- Down from each seed through current children, to any depth.
  inside as (
    select s.item_id, 1 as depth from inside_seeds s
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.character_asset_version c on c.location_id = i.item_id and c.is_current
    where i.depth < 64
  ),
  included as (
    select s.item_id, 1 as depth from included_seeds s
    union all
    select c.item_id, i.depth + 1
    from included i
    join public.character_asset_version c on c.location_id = i.item_id and c.is_current
    where i.depth < 64
  ),
  excluded as (
    select s.item_id, 1 as depth from excluded_seeds s
    union all
    select c.item_id, e.depth + 1
    from excluded e
    join public.character_asset_version c on c.location_id = e.item_id and c.is_current
    where e.depth < 64
  ),
  -- Each walk once per item. The sets are joined, never tested with IN: an IN
  -- under the OR that switches a filter off runs as a subplan rescanning the
  -- walk for every row.
  inside_ids as (select distinct i.item_id from inside i),
  included_ids as (select distinct n.item_id from included n),
  excluded_ids as (select distinct x.item_id from excluded x),
  -- What the location and include filters keep: one walk, or both where both
  -- are set. Each branch is switched on by the filters alone.
  kept_ids as (
    select i.item_id from inside_ids i
    where coalesce(cardinality(include_flags), 0) = 0
    union all
    select i.item_id from inside_ids i join included_ids n on n.item_id = i.item_id
    where coalesce(cardinality(include_flags), 0) > 0
    union all
    select n.item_id from included_ids n
    where coalesce(cardinality(location_ids), 0) = 0
  ),
  candidates as (
    -- The rows a location or include walk reached. Each is a root or was
    -- reached through a parent row the caller can see, so these are the
    -- columns the view shows for it.
    select v.item_id, v.registration_id, v.type_id,
           case when v.location_id is null then l.location_id else v.location_id end as location_id,
           case when v.location_id is null then l.location_flag else v.location_flag end as location_flag,
           case when v.location_id is null then l.location_type else v.location_type end as location_type,
           v.quantity, v.is_singleton, v.is_blueprint_copy, v.name
    from kept_ids k
    join public.character_asset_version v on v.item_id = k.item_id and v.is_current
    left join public.character_asset_location l on l.asset_id = v.id
    where v.registration_id = any(registration_ids)
      and (coalesce(cardinality(type_ids), 0) = 0 or v.type_id = any(type_ids))
    union all
    -- An exclusion alone: every row of the owners, through the view.
    select a.item_id, a.registration_id, a.type_id, a.location_id, a.location_flag, a.location_type,
           a.quantity, a.is_singleton, a.is_blueprint_copy, a.name
    from public.character_asset a
    where coalesce(cardinality(location_ids), 0) = 0
      and coalesce(cardinality(include_flags), 0) = 0
      and a.registration_id = any(registration_ids)
      and (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
  ),
  matched as (
    select c.*
    from candidates c
    left join excluded_ids x on x.item_id = c.item_id
    where x.item_id is null
  )
  select json_build_object(
    'total', (select count(*) from matched),
    'rows', coalesce(
      (select json_agg(r order by r.item_id)
       from (
         select * from matched m
         order by m.item_id
         limit least(greatest(coalesce(row_limit, 0), 0), 50000)
       ) r),
      '[]'::json
    )
  );
$$;

-- The corp mirror. Corp assets have no custom name column, and the owner list
-- is corporation ids.
create or replace function public.corp_asset_within(
  corporation_ids bigint[],
  type_ids bigint[] default null,
  location_ids bigint[] default null,
  include_flags text[] default null,
  exclude_flags text[] default null,
  row_limit int default 5000
)
returns json
language sql
stable
-- The planner cannot size a recursive walk, so it guesses millions of rows,
-- prices the query past jit_above_cost, and spends about a second compiling a
-- plan that runs in a tenth of that.
set jit = off
as $$
  with recursive
  -- The places the location filter names: the ids themselves, and for a solar
  -- system every NPC station and player structure in it.
  places as (
    select unnest(location_ids) as place_id
    union
    select st.station_id
    from public.sde_station st
    where coalesce(cardinality(location_ids), 0) > 0
      and st.system_id = any(location_ids)
    union
    select cs.structure_id
    from public.corp_structure cs
    where coalesce(cardinality(location_ids), 0) > 0
      and cs.system_id = any(location_ids)
    union
    select us.structure_id
    from public.universe_structure us
    where coalesce(cardinality(location_ids), 0) > 0
      and us.system_id = any(location_ids)
  ),
  -- Where each walk starts: a root whose place (or hangar) the filter names,
  -- read from the location table, and any other item whose parent (or own
  -- hangar) it names, counted only when that parent has a current row the
  -- caller can see.
  inside_seeds as (
    select v.item_id
    from public.corp_asset_location l
    join public.corp_asset_version v on v.id = l.asset_id and v.is_current and v.location_id is null
    where coalesce(cardinality(location_ids), 0) > 0
      and v.corporation_id = any(corporation_ids)
      and l.location_id in (select p.place_id from places p)
    union all
    select v.item_id
    from public.corp_asset_version v
    where coalesce(cardinality(location_ids), 0) > 0
      and v.is_current
      and v.corporation_id = any(corporation_ids)
      and v.location_id in (select p.place_id from places p)
      and exists (select 1 from public.corp_asset_version pv where pv.item_id = v.location_id and pv.is_current)
  ),
  included_seeds as (
    select v.item_id
    from public.corp_asset_location l
    join public.corp_asset_version v on v.id = l.asset_id and v.is_current and v.location_id is null
    where coalesce(cardinality(include_flags), 0) > 0
      and v.corporation_id = any(corporation_ids)
      and l.location_flag = any(include_flags)
    union all
    select v.item_id
    from public.corp_asset_version v
    where coalesce(cardinality(include_flags), 0) > 0
      and v.is_current
      and v.corporation_id = any(corporation_ids)
      and v.location_flag = any(include_flags)
      and exists (select 1 from public.corp_asset_version pv where pv.item_id = v.location_id and pv.is_current)
  ),
  excluded_seeds as (
    select v.item_id
    from public.corp_asset_location l
    join public.corp_asset_version v on v.id = l.asset_id and v.is_current and v.location_id is null
    where coalesce(cardinality(exclude_flags), 0) > 0
      and v.corporation_id = any(corporation_ids)
      and l.location_flag = any(exclude_flags)
    union all
    select v.item_id
    from public.corp_asset_version v
    where coalesce(cardinality(exclude_flags), 0) > 0
      and v.is_current
      and v.corporation_id = any(corporation_ids)
      and v.location_flag = any(exclude_flags)
      and exists (select 1 from public.corp_asset_version pv where pv.item_id = v.location_id and pv.is_current)
  ),
  -- Down from each seed through current children, to any depth.
  inside as (
    select s.item_id, 1 as depth from inside_seeds s
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.corp_asset_version c on c.location_id = i.item_id and c.is_current
    where i.depth < 64
  ),
  included as (
    select s.item_id, 1 as depth from included_seeds s
    union all
    select c.item_id, i.depth + 1
    from included i
    join public.corp_asset_version c on c.location_id = i.item_id and c.is_current
    where i.depth < 64
  ),
  excluded as (
    select s.item_id, 1 as depth from excluded_seeds s
    union all
    select c.item_id, e.depth + 1
    from excluded e
    join public.corp_asset_version c on c.location_id = e.item_id and c.is_current
    where e.depth < 64
  ),
  -- Each walk once per item. The sets are joined, never tested with IN: an IN
  -- under the OR that switches a filter off runs as a subplan rescanning the
  -- walk for every row.
  inside_ids as (select distinct i.item_id from inside i),
  included_ids as (select distinct n.item_id from included n),
  excluded_ids as (select distinct x.item_id from excluded x),
  -- What the location and include filters keep: one walk, or both where both
  -- are set. Each branch is switched on by the filters alone.
  kept_ids as (
    select i.item_id from inside_ids i
    where coalesce(cardinality(include_flags), 0) = 0
    union all
    select i.item_id from inside_ids i join included_ids n on n.item_id = i.item_id
    where coalesce(cardinality(include_flags), 0) > 0
    union all
    select n.item_id from included_ids n
    where coalesce(cardinality(location_ids), 0) = 0
  ),
  candidates as (
    -- The rows a location or include walk reached. Each is a root or was
    -- reached through a parent row the caller can see, so these are the
    -- columns the view shows for it.
    select v.item_id, v.corporation_id, v.type_id,
           case when v.location_id is null then l.location_id else v.location_id end as location_id,
           case when v.location_id is null then l.location_flag else v.location_flag end as location_flag,
           case when v.location_id is null then l.location_type else v.location_type end as location_type,
           v.quantity, v.is_singleton, v.is_blueprint_copy
    from kept_ids k
    join public.corp_asset_version v on v.item_id = k.item_id and v.is_current
    left join public.corp_asset_location l on l.asset_id = v.id
    where v.corporation_id = any(corporation_ids)
      and (coalesce(cardinality(type_ids), 0) = 0 or v.type_id = any(type_ids))
    union all
    -- An exclusion alone: every row of the owners, through the view.
    select a.item_id, a.corporation_id, a.type_id, a.location_id, a.location_flag, a.location_type,
           a.quantity, a.is_singleton, a.is_blueprint_copy
    from public.corp_asset a
    where coalesce(cardinality(location_ids), 0) = 0
      and coalesce(cardinality(include_flags), 0) = 0
      and a.corporation_id = any(corporation_ids)
      and (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
  ),
  matched as (
    select c.*
    from candidates c
    left join excluded_ids x on x.item_id = c.item_id
    where x.item_id is null
  )
  select json_build_object(
    'total', (select count(*) from matched),
    'rows', coalesce(
      (select json_agg(r order by r.item_id)
       from (
         select * from matched m
         order by m.item_id
         limit least(greatest(coalesce(row_limit, 0), 0), 50000)
       ) r),
      '[]'::json
    )
  );
$$;

grant execute on function public.character_asset_within(uuid[], bigint[], bigint[], text[], text[], int) to authenticated, service_role;
grant execute on function public.corp_asset_within(bigint[], bigint[], bigint[], text[], text[], int)     to authenticated, service_role;

notify pgrst, 'reload schema';
