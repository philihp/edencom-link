-- Rollback for supabase/migrations/20260926054546_asset_location_split.sql.
--
-- NOT a migration: run it by hand only to undo the split, in ONE transaction
-- so a failed check leaves nothing half done:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f docs/sharing-layer/rollback-location-split.sql
-- It puts every place back on its version row, drops the two views and
-- the place table, renames the table back, recreates the character_asset view
-- and restores the eight functions to their pre-split bodies (taken from the
-- schema.sql of that commit). Versions the new claim wrote after the split
-- roll back the same way: their places are in the same table.
--
-- Leaves character_asset_share.show_as_main in place — an extra column the
-- old code never reads.
--
-- Tested in test/sql/asset_location_split_rollback.sql: old schema → the
-- migration → this script gives the old schema's pg_dump and the same row
-- fingerprint.

-- ── the same fingerprint the migration checked ───────────────────────────
create temp table asset_location_split_before as
  select count(*) as rows,
         count(location_id) as placed,
         sum(hashtextextended(
           id::text || ':' || coalesce(location_id::text, '') || ':' || coalesce(location_flag, '') || ':' || coalesce(location_type, ''),
           0))::numeric as fingerprint
  from public.character_asset_over_time;

-- ── places back onto the version rows ────────────────────────────────────
update public.character_asset_version v
   set location_id = l.location_id, location_flag = l.location_flag, location_type = l.location_type
  from public.character_asset_location l
 where l.asset_id = v.id;

do $$
declare
  before record;
  after  record;
begin
  select * into before from asset_location_split_before;
  select count(*) as rows,
         count(location_id) as placed,
         sum(hashtextextended(
           id::text || ':' || coalesce(location_id::text, '') || ':' || coalesce(location_flag, '') || ':' || coalesce(location_type, ''),
           0))::numeric as fingerprint
    into after
  from public.character_asset_version;
  if before.rows <> after.rows or before.placed <> after.placed or before.fingerprint is distinct from after.fingerprint then
    raise exception 'rollback: the table does not reproduce the view (rows % -> %, placed % -> %). Rolling back the rollback.',
      before.rows, after.rows, before.placed, after.placed;
  end if;
end $$;
drop table asset_location_split_before;

-- ── back to one table ────────────────────────────────────────────────────
drop view public.character_asset;
drop view public.character_asset_over_time;
drop table public.character_asset_location;

alter table public.character_asset_version rename to character_asset_over_time;
do $$
declare r record;
begin
  for r in select conname from pg_constraint where conrelid = 'public.character_asset_over_time'::regclass and contype = 'p' and conname <> 'character_asset_over_time_pkey' loop
    execute format('alter table public.character_asset_over_time rename constraint %I to character_asset_over_time_pkey', r.conname);
  end loop;
  for r in select conname from pg_constraint where conrelid = 'public.character_asset_over_time'::regclass and contype = 'f' and confrelid = 'public.registration'::regclass and conname <> 'character_asset_over_time_registration_id_fkey' loop
    execute format('alter table public.character_asset_over_time rename constraint %I to character_asset_over_time_registration_id_fkey', r.conname);
  end loop;
  for r in select s.relname from pg_class s join pg_depend d on d.objid = s.oid and d.deptype = 'i' where s.relkind = 'S' and d.refobjid = 'public.character_asset_over_time'::regclass and s.relname <> 'character_asset_over_time_id_seq' loop
    execute format('alter sequence public.%I rename to character_asset_over_time_id_seq', r.relname);
  end loop;
end $$;
alter index if exists public.character_asset_version_registration_id_idx rename to character_asset_over_time_registration_id_idx;
alter index if exists public.character_asset_version_current_item_idx rename to character_asset_over_time_current_item_idx;
alter index if exists public.character_asset_version_item_id_idx rename to character_asset_over_time_item_id_idx;
alter index if exists public.character_asset_version_current_location_idx rename to character_asset_over_time_current_location_idx;

create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;

grant select on public.character_asset_over_time to anon, authenticated;
grant select on public.character_asset           to anon, authenticated;
grant all    on public.character_asset_over_time to service_role;

-- ── the pre-split functions ──────────────────────────────────────────────
create or replace function public.character_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.character_asset_over_time')::bigint);

  update public.character_asset_over_time
     set is_current = false
   where is_current
     and item_id = any (v_items);

  insert into public.character_asset_over_time
    (item_id, registration_id, type_id, location_id, location_flag, location_type,
     quantity, is_singleton, is_blueprint_copy, valid_until, name)
  select (r->>'item_id')::bigint,
         (r->>'registration_id')::uuid,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         r->>'location_type',
         (r->>'quantity')::bigint,
         (r->>'is_singleton')::boolean,
         coalesce((r->>'is_blueprint_copy')::boolean, false),
         coalesce((r->>'valid_until')::timestamptz, now()),
         r->>'name'
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

create or replace function public.character_asset_location_contents(parent bigint)
returns table (item_id bigint, contents bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id as root_child, a.item_id as node, 1 as depth
    from public.character_asset a
    where a.location_id = parent
    union all
    select d.root_child, c.item_id, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.node
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

create or replace function public.character_asset_subtree_items(parent bigint)
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.character_asset a
    where a.location_id = parent
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.item_id
    where d.depth < 64
  )
  select
    d.type_id,
    sum(case when d.is_singleton then 1 else coalesce(d.quantity, 1) end)::bigint as quantity
  from descend d
  group by d.type_id;
$$;

create or replace function public.character_asset_subtree_items(parents bigint[])
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.character_asset a
    where a.location_id = any(parents)
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.item_id
    where d.depth < 64
  ),
  once as (
    select distinct on (item_id) item_id, type_id, quantity, is_singleton
    from descend
    order by item_id
  )
  select
    o.type_id,
    sum(case when o.is_singleton then 1 else coalesce(o.quantity, 1) end)::bigint as quantity
  from once o
  where o.item_id <> all(parents)
  group by o.type_id;
$$;

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
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  matched as (
    select a.item_id, a.registration_id, a.type_id, a.quantity, a.is_singleton, a.name,
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
  left join public.character_asset p on p.item_id = m.location_id;
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
    join public.character_asset c on c.location_id = i.item_id
    where i.depth < 64
  ),
  parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  matched as (
    select a.item_id, a.registration_id, a.type_id, a.quantity, a.is_singleton, a.name,
           a.location_flag, a.location_id, a.location_type
    from public.character_asset a
    where (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
      and (coalesce(cardinality(registration_ids), 0) = 0 or a.registration_id = any(registration_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or a.item_id in (select i.item_id from inside i))
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
  left join public.character_asset p on p.item_id = m.location_id;
$$;

create or replace function public.asset_share_covers(item bigint, registration uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.item_id
      from character_asset_share s
      where s.registration_id = asset_share_covers.registration
        and asset_share_matches_caller(s.corporation_ids, s.alliance_ids, s.secret)
    ),
    walk (node, depth) as (
      select asset_share_covers.item, 0
      union all
      select parent.location_id, w.depth + 1
      from walk w
      cross join lateral (
        select o.location_id
        from character_asset_over_time o
        where o.item_id = w.node
        order by o.is_current desc, o.valid_until desc
        limit 1
      ) parent
      where w.depth < 16
        and parent.location_id is not null
        and exists (select 1 from matching_shares)
    )
  select exists (
    select 1
    from walk w
    join matching_shares m on m.item_id = w.node
  );
$$;

create or replace function public.asset_ancestors(start_id bigint)
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int, type_name text)
language sql
stable
as $$
  -- `not materialized` matters: parent_of is referenced twice (base term and
  -- recursive term), so by default Postgres materializes all ~117k current
  -- character+corp asset rows and then filters down to one, leaving the
  -- item_id index unused. Inlined, the base term is an index seek.
  with recursive parent_of as not materialized (
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
  -- The type name is a scalar subquery, not a join: a recursive CTE's row
  -- estimate is wild (41,202 against an actual 1 on a real container), and
  -- against `left join sde_published_type` that made the planner hash the whole
  -- view — a seq scan parsing 52,848 jsonb documents, ~3s, to label one row.
  -- Keyed on _key, so at most one row matches and this is equivalent.
  select
    w.item_id,
    w.type_id,
    w.name,
    w.location_id,
    w.location_type,
    w.depth,
    (select t.name from public.sde_published_type t where t.type_id = w.type_id) as type_name
  from walk w
  order by w.depth;
$$;

revoke execute on function public.character_asset_claim(jsonb) from public, anon, authenticated;
grant execute on function public.character_asset_claim(jsonb) to service_role;
revoke execute on function public.asset_share_covers(bigint, uuid) from public;
grant execute on function public.asset_share_covers(bigint, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
