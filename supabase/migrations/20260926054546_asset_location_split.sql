-- Split an asset's place off the asset row, so sharing an asset never says
-- where it is (docs/sharing-layer/11-location-split.md).
--
-- An asset row's location_id does two jobs. For an item inside a ship or a
-- container, it names that parent item. For a root item, it names the place
-- the whole tree sits: a station, a solar system, or a player structure (which
-- ESI reports as location_type 'item', because a structure is an item too).
-- The share policy "Audience reads shared assets" returns whole rows, so a
-- shared ship's own row handed its station or structure to every recipient,
-- and to anyone at all when the share was public.
--
-- After this migration:
--   * character_asset_version is the table (renamed from
--     character_asset_over_time). Its location columns hold only a parent
--     that is another asset of the same owner. For a root item they are null.
--   * character_asset_location holds the root item's place, 1:1 with the
--     version row it belongs to, so it keeps the same SCD-2 history. Its RLS
--     is owner-only: this is the table a later "share the location too"
--     feature would widen, with its own rules.
--   * character_asset_over_time and character_asset are security-invoker
--     views that put the two back together, with the same columns in the same
--     order as before. The owner sees exactly what they saw before. A share
--     recipient sees the place as null, because the location table's RLS
--     does not let them read it.
--
-- Every function, page and job that reads character_asset_over_time or
-- character_asset keeps working unchanged. Only writes move to the table: the
-- extract's valid_until/is_current updates and character_asset_claim().

-- ── the table ─────────────────────────────────────────────────────────────
drop view if exists public.character_asset;

alter table public.character_asset_over_time rename to character_asset_version;
alter table public.character_asset_version rename constraint character_asset_over_time_pkey to character_asset_version_pkey;
alter table public.character_asset_version
  rename constraint character_asset_over_time_registration_id_fkey to character_asset_version_registration_id_fkey;
alter sequence public.character_asset_over_time_id_seq rename to character_asset_version_id_seq;
alter index public.character_asset_over_time_registration_id_idx rename to character_asset_version_registration_id_idx;
alter index public.character_asset_over_time_current_item_idx rename to character_asset_version_current_item_idx;
alter index public.character_asset_over_time_item_id_idx rename to character_asset_version_item_id_idx;
alter index public.character_asset_over_time_current_location_idx rename to character_asset_version_current_location_idx;

-- ── the place ─────────────────────────────────────────────────────────────
create table public.character_asset_location (
  asset_id bigint primary key references public.character_asset_version (id) on delete cascade,
  -- Denormalized from the version row, so the owner policy is one indexed
  -- probe rather than a join back to the asset table.
  registration_id uuid not null references public.registration (id) on delete cascade,
  location_id bigint not null,
  location_flag text,
  location_type text
);
create index character_asset_location_location_id_idx on public.character_asset_location (location_id);
create index character_asset_location_registration_id_idx on public.character_asset_location (registration_id);

alter table public.character_asset_location enable row level security;
create policy "Users read own asset locations"
  on public.character_asset_location
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- anon holds the grant but no policy, so it reads no rows: the views join
-- this table, and a view that anon may read must not fail on it.
revoke all on public.character_asset_location from anon, authenticated;
grant select on public.character_asset_location to anon, authenticated;
grant all on public.character_asset_location to service_role;

-- ── backfill ──────────────────────────────────────────────────────────────
-- A version's location is its place when no version of any item of the same
-- owner has that id: then it is not a parent inside the owner's own tree.
insert into public.character_asset_location (asset_id, registration_id, location_id, location_flag, location_type)
select v.id, v.registration_id, v.location_id, v.location_flag, v.location_type
from public.character_asset_version v
where v.location_id is not null
  and not exists (
    select 1
    from public.character_asset_version p
    where p.item_id = v.location_id
      and p.registration_id = v.registration_id
  );

update public.character_asset_version v
   set location_id = null, location_flag = null, location_type = null
  from public.character_asset_location l
 where l.asset_id = v.id;

-- ── the views ─────────────────────────────────────────────────────────────
-- UNION ALL rather than one left join with coalesce(): a filter on
-- location_id (children of a ship, the items at a station) then reaches an
-- index in each branch — the version table's partial location index in the
-- first, the location table's in the second. coalesce() would hide the column
-- from both and scan.
create view public.character_asset_over_time with (security_invoker = on) as
  select v.id, v.item_id, v.registration_id, v.type_id,
         v.location_id, v.location_flag, v.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until, v.name
  from public.character_asset_version v
  where v.location_id is not null
  union all
  select v.id, v.item_id, v.registration_id, v.type_id,
         l.location_id, l.location_flag, l.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until, v.name
  from public.character_asset_version v
  left join public.character_asset_location l on l.asset_id = v.id
  where v.location_id is null;

create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;

grant select on public.character_asset_over_time to anon, authenticated, service_role;
grant select on public.character_asset           to anon, authenticated, service_role;

-- ── writes ────────────────────────────────────────────────────────────────
-- The claim now writes the version row and, for a root item, its place. A
-- location is a parent when it is the item id of an open row of the same
-- owner, counting the rows this same call inserts (a container and its
-- contents arriving together); anything else is the item's place.
create or replace function public.character_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_ids      bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.character_asset_over_time')::bigint);

  update public.character_asset_version
     set is_current = false
   where is_current
     and item_id = any (v_items);

  with inserted as (
    insert into public.character_asset_version
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
      from jsonb_array_elements(p_rows) r
    returning id
  )
  select array_agg(id) into v_ids from inserted;
  v_inserted := coalesce(array_length(v_ids, 1), 0);

  -- Move each new root item's place into the owner-only table.
  insert into public.character_asset_location (asset_id, registration_id, location_id, location_flag, location_type)
  select v.id, v.registration_id, v.location_id, v.location_flag, v.location_type
    from public.character_asset_version v
   where v.id = any (v_ids)
     and v.location_id is not null
     and not exists (
       select 1
         from public.character_asset_version p
        where p.is_current
          and p.item_id = v.location_id
          and p.registration_id = v.registration_id
     );

  update public.character_asset_version v
     set location_id = null, location_flag = null, location_type = null
    from public.character_asset_location l
   where l.asset_id = v.id
     and v.id = any (v_ids);

  return v_inserted;
end
$$;

revoke execute on function public.character_asset_claim(jsonb) from public, anon, authenticated;
grant execute on function public.character_asset_claim(jsonb) to service_role;

-- ── the share walk ────────────────────────────────────────────────────────
-- Unchanged in meaning; it now climbs the version table directly. It only
-- ever needed parent links, and those are exactly what that table still
-- holds: the climb stops at the root item, whose place it never reads.
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
        from character_asset_version o
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

revoke execute on function public.asset_share_covers(bigint, uuid) from public;
grant execute on function public.asset_share_covers(bigint, uuid) to anon, authenticated;

-- ── the walks ─────────────────────────────────────────────────────────────
-- A child always names its parent on the version table itself, never through
-- the location table, so each recursive step (into a container, up to a
-- parent) joins character_asset_version directly. Through the character_asset
-- view it could not: the view is a UNION ALL with a join inside, and the
-- planner cannot push a join condition into that branch, so every step
-- scanned the whole table (7 ms → 760 ms for one station's contents at 180k
-- rows). Only the seeds — "what is at this place" — still read the view,
-- which is also what keeps a recipient's walk from starting at a station.
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
    join public.character_asset_version c on c.location_id = d.node and c.is_current
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
    join public.character_asset_version c on c.location_id = d.item_id and c.is_current
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
    join public.character_asset_version c on c.location_id = d.item_id and c.is_current
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
    -- The version table itself, not the character_asset view: the view is a
    -- UNION ALL with a join inside, which the planner cannot seek into per
    -- step. The walk climbs parent links only; a character item's place is
    -- looked up once, for the root, in the select below.
    select v.id as version_id, v.item_id, v.type_id, v.name, v.location_id, v.location_type
    from public.character_asset_version v
    where v.is_current
    union all
    select null::bigint as version_id, item_id, type_id, null::text as name, location_id, location_type
    from public.corp_asset
  ),
  walk as (
    select p.version_id, p.item_id, p.type_id, p.name, p.location_id, p.location_type, 1 as depth
    from parent_of p
    where p.item_id = start_id
    union all
    select p.version_id, p.item_id, p.type_id, p.name, p.location_id, p.location_type, w.depth + 1
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
    -- The root's place, from the owner-only location table: RLS answers null
    -- to a share recipient, so their walk ends at the shared item with no
    -- place. Corp rows (version_id null) keep their own location columns.
    coalesce(w.location_id, (select l.location_id from public.character_asset_location l where l.asset_id = w.version_id)) as location_id,
    coalesce(w.location_type, (select l.location_type from public.character_asset_location l where l.asset_id = w.version_id)) as location_type,
    w.depth,
    (select t.name from public.sde_published_type t where t.type_id = w.type_id) as type_name
  from walk w
  order by w.depth;
$$;

-- ── owner shown as the main character ─────────────────────────────────────
-- A share can show the grantor account's main character as the owner rather
-- than the alt holding the item. Presentation only (see the column comment in
-- schema.sql): the asset rows still carry the holder's registration_id.
alter table public.character_asset_share add column show_as_main boolean not null default false;
