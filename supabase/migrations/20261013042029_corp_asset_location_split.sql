-- Split a corp asset's place off the asset row: the corp twin of
-- 20260926054546_asset_location_split.sql, and PR 1 of
-- docs/sharing-layer/14-corp-asset-share.md.
--
-- A corp asset row's location_id does the same two jobs a character one did
-- before phase 11: a parent item for anything inside an office, ship or
-- container, and the place (station, structure, system) for a root item. A
-- corp asset share (PR 3) widens reads with a policy that returns whole rows,
-- so a shared container's own row would hand the corp's office location to
-- every recipient. This moves the place into an owner-only table first; until
-- that share exists, nothing a caller sees changes.
--
-- After this migration:
--   * corp_asset_version is the table (renamed from corp_asset_over_time). Its
--     location columns hold only a parent that is another asset of the same
--     corporation. For a root item they are null.
--   * corp_asset_location holds the root item's place, 1:1 with the version
--     row it belongs to. Its RLS is members only, the predicate the table
--     itself carries.
--   * corp_asset_over_time and corp_asset are security-invoker views that put
--     the two back together, with the same columns in the same order.
--
-- Checked against production before writing (2026-10-13): 226k rows, 15
-- corporations; no item id in the station/system range (the smallest is
-- 101,430,574); no current row whose parent is only history. Hangar items
-- (CorpSAG1-7) name the corporation's Office item, and the Office
-- (OfficeFolder) is the root that names the station or structure — so the
-- root is still "the first location_id that is not an asset of the same
-- owner". Nine rows link to an item another corporation held; by that rule
-- they are roots, and their place is that item's id, as the summary walk
-- already reads them.

-- ── the table ─────────────────────────────────────────────────────────────
drop view if exists public.corp_asset;

alter table public.corp_asset_over_time rename to corp_asset_version;

-- A table rename never renames its constraints or its identity sequence, so
-- discover them from the catalogs and rename whatever is there, as the
-- character split did. A name already in step is left alone.
do $$
declare
  r record;
begin
  for r in
    select conname
      from pg_constraint
     where conrelid = 'public.corp_asset_version'::regclass
       and contype = 'p'
       and conname <> 'corp_asset_version_pkey'
  loop
    execute format('alter table public.corp_asset_version rename constraint %I to corp_asset_version_pkey', r.conname);
  end loop;

  for r in
    select s.relname
      from pg_class s
      join pg_depend d on d.objid = s.oid and d.deptype = 'i'
     where s.relkind = 'S'
       and d.refobjid = 'public.corp_asset_version'::regclass
       and s.relname <> 'corp_asset_version_id_seq'
  loop
    execute format('alter sequence public.%I rename to corp_asset_version_id_seq', r.relname);
  end loop;
end $$;

alter index if exists public.corp_asset_over_time_corporation_id_idx rename to corp_asset_version_corporation_id_idx;
alter index if exists public.corp_asset_over_time_current_item_idx rename to corp_asset_version_current_item_idx;
alter index if exists public.corp_asset_over_time_item_id_idx rename to corp_asset_version_item_id_idx;
alter index if exists public.corp_asset_over_time_current_location_idx rename to corp_asset_version_current_location_idx;
alter index if exists public.corp_asset_over_time_history_location_idx rename to corp_asset_version_history_location_idx;

-- ── the safety net ────────────────────────────────────────────────────────
-- A place is copied to the new table first and nulled on the version row
-- second, in this one transaction. This fingerprint of every row's location
-- data, compared after the move, raises and rolls the file back if anything
-- was lost.
create temp table corp_asset_location_split_before as
  select count(*) as rows,
         count(location_id) as placed,
         sum(hashtextextended(
           id::text || ':' || coalesce(location_id::text, '') || ':' || coalesce(location_flag, '') || ':' || coalesce(location_type, ''),
           0))::numeric as fingerprint
  from public.corp_asset_version;

-- ── the place ─────────────────────────────────────────────────────────────
create table public.corp_asset_location (
  asset_id bigint primary key references public.corp_asset_version (id) on delete cascade,
  -- Denormalized from the version row, so the member policy is one indexed
  -- probe rather than a join back to the asset table.
  corporation_id bigint not null,
  location_id bigint not null,
  location_flag text,
  location_type text
);
create index corp_asset_location_location_id_idx on public.corp_asset_location (location_id);
create index corp_asset_location_corporation_id_idx on public.corp_asset_location (corporation_id);

alter table public.corp_asset_location enable row level security;
create policy "Users read asset locations for own corps"
  on public.corp_asset_location
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );

-- anon holds the grant but no policy, so it reads no rows: once a corp share
-- can be public, the views join this table under anon, and a view anon may
-- read must not fail on it.
revoke all on public.corp_asset_location from anon, authenticated;
grant select on public.corp_asset_location to anon, authenticated;
grant all on public.corp_asset_location to service_role;

-- ── backfill ──────────────────────────────────────────────────────────────
-- A version's location is its place when no version of any item of the same
-- corporation has that id.
insert into public.corp_asset_location (asset_id, corporation_id, location_id, location_flag, location_type)
select v.id, v.corporation_id, v.location_id, v.location_flag, v.location_type
from public.corp_asset_version v
where v.location_id is not null
  and not exists (
    select 1
    from public.corp_asset_version p
    where p.item_id = v.location_id
      and p.corporation_id = v.corporation_id
  );

update public.corp_asset_version v
   set location_id = null, location_flag = null, location_type = null
  from public.corp_asset_location l
 where l.asset_id = v.id;

-- ── the views ─────────────────────────────────────────────────────────────
-- The character view's three branches, for the same reasons: a filter on
-- location_id reaches an index in each; a parent link shows only when the
-- caller can see the parent row; a root's place comes from the members-only
-- table.
create view public.corp_asset_over_time with (security_invoker = on) as
  -- 1. A parent link the caller can see.
  select v.id, v.item_id, v.corporation_id, v.type_id,
         v.location_id, v.location_flag, v.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until
  from public.corp_asset_version v
  where v.location_id is not null
    and exists (select 1 from public.corp_asset_version p where p.item_id = v.location_id and p.is_current)
  union all
  -- 2. A parent link the caller cannot see: reads null, flag and type
  --    included, so the row says nothing about what holds it.
  select v.id, v.item_id, v.corporation_id, v.type_id,
         null::bigint, null::text, null::text,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until
  from public.corp_asset_version v
  where v.location_id is not null
    and not exists (select 1 from public.corp_asset_version p where p.item_id = v.location_id and p.is_current)
  union all
  -- 3. A root item and its place, from the members-only table.
  select v.id, v.item_id, v.corporation_id, v.type_id,
         l.location_id, l.location_flag, l.location_type,
         v.quantity, v.is_singleton, v.is_blueprint_copy, v.is_current, v.valid_from, v.valid_until
  from public.corp_asset_version v
  left join public.corp_asset_location l on l.asset_id = v.id
  where v.location_id is null;

create view public.corp_asset with (security_invoker = on) as
  select * from public.corp_asset_over_time where is_current;

grant select on public.corp_asset_over_time to authenticated, service_role;
grant select on public.corp_asset           to authenticated, service_role;

do $$
declare
  before record;
  after  record;
begin
  select * into before from corp_asset_location_split_before;
  select count(*) as rows,
         count(location_id) as placed,
         sum(hashtextextended(
           id::text || ':' || coalesce(location_id::text, '') || ':' || coalesce(location_flag, '') || ':' || coalesce(location_type, ''),
           0))::numeric as fingerprint
    into after
  from (
    select v.id,
           coalesce(v.location_id,   l.location_id)   as location_id,
           coalesce(v.location_flag, l.location_flag) as location_flag,
           coalesce(v.location_type, l.location_type) as location_type
    from public.corp_asset_version v
    left join public.corp_asset_location l on l.asset_id = v.id
  ) joined;

  if before.rows <> after.rows
     or before.placed <> after.placed
     or before.fingerprint is distinct from after.fingerprint then
    raise exception 'corp asset location split: the tables do not reproduce the original (rows % -> %, placed % -> %, fingerprint % -> %). Rolling back.',
      before.rows, after.rows, before.placed, after.placed, before.fingerprint, after.fingerprint;
  end if;

  if exists (select 1 from public.corp_asset_version v join public.corp_asset_location l on l.asset_id = v.id where v.location_id is not null) then
    raise exception 'corp asset location split: a version row kept its place after the move. Rolling back.';
  end if;
end $$;
drop table corp_asset_location_split_before;

-- ── writes ────────────────────────────────────────────────────────────────
-- The claim writes the version row and, for a root item, its place; then
-- relinks any child that arrived before its container. The character claim's
-- body over the corp tables.
create or replace function public.corp_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_ids      bigint[];
  v_now      timestamptz;
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint),
         coalesce(min((r->>'valid_until')::timestamptz), now())
    into v_items, v_now
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.corp_asset_over_time')::bigint);

  update public.corp_asset_version
     set is_current = false, valid_until = v_now
   where is_current
     and item_id = any (v_items);

  with inserted as (
    insert into public.corp_asset_version
      (item_id, corporation_id, type_id, location_id, location_flag, location_type,
       quantity, is_singleton, is_blueprint_copy, valid_until)
    select (r->>'item_id')::bigint,
           (r->>'corporation_id')::bigint,
           (r->>'type_id')::bigint,
           (r->>'location_id')::bigint,
           r->>'location_flag',
           r->>'location_type',
           (r->>'quantity')::bigint,
           (r->>'is_singleton')::boolean,
           coalesce((r->>'is_blueprint_copy')::boolean, false),
           coalesce((r->>'valid_until')::timestamptz, now())
      from jsonb_array_elements(p_rows) r
    returning id
  )
  select array_agg(id) into v_ids from inserted;
  v_inserted := coalesce(array_length(v_ids, 1), 0);

  insert into public.corp_asset_location (asset_id, corporation_id, location_id, location_flag, location_type)
  select v.id, v.corporation_id, v.location_id, v.location_flag, v.location_type
    from public.corp_asset_version v
   where v.id = any (v_ids)
     and v.location_id is not null
     and not exists (
       select 1
         from public.corp_asset_version p
        where p.is_current
          and p.item_id = v.location_id
          and p.corporation_id = v.corporation_id
     );

  update public.corp_asset_version v
     set location_id = null, location_flag = null, location_type = null
    from public.corp_asset_location l
   where l.asset_id = v.id
     and v.id = any (v_ids);

  with relinked as (
    delete from public.corp_asset_location l
     using public.corp_asset_version c, public.corp_asset_version p
     where c.id = l.asset_id
       and c.is_current
       and p.is_current
       and p.item_id = l.location_id
       and p.corporation_id = l.corporation_id
       and p.item_id = any (v_items)
    returning l.asset_id, l.location_id, l.location_flag, l.location_type
  )
  update public.corp_asset_version v
     set location_id = r.location_id, location_flag = r.location_flag, location_type = r.location_type
    from relinked r
   where v.id = r.asset_id;

  return v_inserted;
end
$$;

revoke execute on function public.corp_asset_claim(jsonb) from public, anon, authenticated;
grant execute on function public.corp_asset_claim(jsonb) to service_role;

-- ── the walks ─────────────────────────────────────────────────────────────
-- Each recursive step joins corp_asset_version directly: a child names its
-- parent on the version table, and a join condition cannot reach into the
-- view's join branch. Seeds ("what is at this place") stay on the view.
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
    join public.corp_asset_version c on c.location_id = d.node and c.is_current
    where d.depth < 64
  )
  select root_child as item_id, count(*) - 1 as contents
  from descend
  group by root_child;
$$;

create or replace function public.corp_asset_subtree_items(parent bigint)
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.corp_asset a
    where a.location_id = parent
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.corp_asset_version c on c.location_id = d.item_id and c.is_current
    where d.depth < 64
  )
  select
    d.type_id,
    sum(case when d.is_singleton then 1 else coalesce(d.quantity, 1) end)::bigint as quantity
  from descend d
  group by d.type_id;
$$;

create or replace function public.corp_asset_subtree_items(parents bigint[])
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.corp_asset a
    where a.location_id = any(parents)
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.corp_asset_version c on c.location_id = d.item_id and c.is_current
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

create or replace function public.corp_asset_search(type_ids bigint[])
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
  with recursive matched as (
    select a.item_id, a.corporation_id, a.type_id, a.quantity, a.is_singleton,
           a.location_flag, a.location_id, a.location_type
    from public.corp_asset a
    where a.type_id = any(type_ids)
  ),
  -- One indexed lookup per step on the version table, stopping at a row with
  -- no parent link; roots reads that row's place from the location table.
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
    p.type_id as parent_type_id
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.corp_asset_version p on p.item_id = m.location_id and p.is_current;
$$;

create or replace function public.corp_asset_filter(
  type_ids bigint[] default null,
  location_ids bigint[] default null,
  corporation_ids bigint[] default null
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
           a.location_flag, a.location_id, a.location_type
    from public.corp_asset a
    where (coalesce(cardinality(type_ids), 0) = 0 or a.type_id = any(type_ids))
      and (coalesce(cardinality(corporation_ids), 0) = 0 or a.corporation_id = any(corporation_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or a.item_id in (select i.item_id from inside i))
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
    p.type_id as parent_type_id
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id
  left join public.corp_asset_version p on p.item_id = m.location_id and p.is_current;
$$;

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
    -- Items directly at a named location: a parent link to it (an office,
    -- container or ship of the corp) or a place there.
    select v.item_id, 1 as depth
    from public.corp_asset_version v
    where coalesce(cardinality(location_ids), 0) > 0
      and v.location_id = any(location_ids)
      and v.valid_from <= as_of
      and (v.is_current or (not v.is_current and v.valid_until >= as_of))
    union all
    select v.item_id, 1 as depth
    from public.corp_asset_location l
    join public.corp_asset_version v on v.id = l.asset_id
    where coalesce(cardinality(location_ids), 0) > 0
      and l.location_id = any(location_ids)
      and v.valid_from <= as_of
      and (v.is_current or (not v.is_current and v.valid_until >= as_of))
    union all
    select c.item_id, i.depth + 1
    from inside i
    join public.corp_asset_version c
      on c.location_id = i.item_id
     and c.valid_from <= as_of
     and (c.is_current or (not c.is_current and c.valid_until >= as_of))
    where i.depth < 64
  ),
  matched as (
    select distinct on (v.item_id)
           v.id, v.item_id, v.corporation_id, v.type_id, v.quantity, v.is_singleton,
           v.location_id as link_id,
           coalesce(v.location_id, l.location_id) as location_id,
           coalesce(v.location_flag, l.location_flag) as location_flag
    from public.corp_asset_version v
    left join public.corp_asset_location l on l.asset_id = v.id
    where v.corporation_id = any(corporation_ids)
      and v.valid_from <= as_of
      and (v.is_current or (not v.is_current and v.valid_until >= as_of))
      and (coalesce(cardinality(type_ids), 0) = 0 or v.type_id = any(type_ids))
      and (coalesce(cardinality(location_ids), 0) = 0 or v.item_id in (select i.item_id from inside i))
    order by v.item_id, v.valid_from desc
  ),
  -- A row whose link is null ends its climb: a root item (version_id set;
  -- its place is in the location table) or a parent no version of which is
  -- visible (version_id null; stuck_at holds the parent's id).
  climb as (
    select m.item_id as start_item, m.id as version_id, m.link_id, null::bigint as stuck_at, 1 as depth
    from matched m
    union all
    select c.start_item, p.id, p.location_id, case when p.id is null then c.link_id end, c.depth + 1
    from climb c
    left join lateral (
      select pv.id, pv.location_id
      from public.corp_asset_version pv
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
    left join public.corp_asset_location l on l.asset_id = c.version_id
    where c.link_id is null
  ),
  descend as (
    select m.item_id as ancestor, m.item_id as node, 1 as depth
    from matched m
    union all
    select d.ancestor, c.item_id, d.depth + 1
    from descend d
    join public.corp_asset_version c
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
    from public.corp_asset_version pv
    where pv.item_id = m.link_id
    order by (pv.valid_from <= as_of and (pv.is_current or pv.valid_until >= as_of)) desc,
             (pv.valid_from <= as_of) desc,
             pv.valid_from desc
    limit 1
  ) p on true;
$$;

-- The breadcrumb: the corp hop now reads the corp version row and its place
-- apart, exactly as the character hop does, so the output rule — a parent is
-- named only when the walk reached it — holds for corp items too once a corp
-- share lets a recipient start the walk inside a corp hangar.
create or replace function public.asset_ancestors(start_id bigint)
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int, type_name text)
language sql
stable
as $$
  with recursive walk as (
    select h.version_id, h.item_id, h.type_id, h.name, h.parent_id, h.parent_type, h.place_id, h.place_type,
           coalesce(h.parent_id, h.place_id) as next_id, 1 as depth
    from (
      select v.id as version_id, v.item_id, v.type_id, v.name,
             v.location_id as parent_id, v.location_type as parent_type,
             (select l.location_id   from public.character_asset_location l where l.asset_id = v.id) as place_id,
             (select l.location_type from public.character_asset_location l where l.asset_id = v.id) as place_type
      from public.character_asset_version v
      where v.is_current and v.item_id = start_id
      union all
      select null::bigint, c.item_id, c.type_id, null::text,
             c.location_id, c.location_type,
             (select l.location_id   from public.corp_asset_location l where l.asset_id = c.id),
             (select l.location_type from public.corp_asset_location l where l.asset_id = c.id)
      from public.corp_asset_version c
      where c.is_current and c.item_id = start_id
    ) h
    union all
    select cv.version_id,
           coalesce(cv.item_id, cc.item_id), coalesce(cv.type_id, cc.type_id), cv.name,
           coalesce(cv.parent_id, cc.parent_id), coalesce(cv.parent_type, cc.parent_type),
           coalesce(cv.place_id, cc.place_id), coalesce(cv.place_type, cc.place_type),
           coalesce(cv.parent_id, cv.place_id, cc.parent_id, cc.place_id), w.depth + 1
    from walk w
    left join lateral (
      select v.id as version_id, v.item_id, v.type_id, v.name,
             v.location_id as parent_id, v.location_type as parent_type,
             (select l.location_id   from public.character_asset_location l where l.asset_id = v.id) as place_id,
             (select l.location_type from public.character_asset_location l where l.asset_id = v.id) as place_type
      from public.character_asset_version v
      where v.is_current and v.item_id = w.next_id
      limit 1
    ) cv on true
    left join lateral (
      select c.item_id, c.type_id,
             c.location_id as parent_id, c.location_type as parent_type,
             (select l.location_id   from public.corp_asset_location l where l.asset_id = c.id) as place_id,
             (select l.location_type from public.corp_asset_location l where l.asset_id = c.id) as place_type
      from public.corp_asset_version c
      where c.is_current and c.item_id = w.next_id and cv.item_id is null
      limit 1
    ) cc on true
    where w.depth < 16
      and w.next_id is not null
      and (cv.item_id is not null or cc.item_id is not null)
  )
  select
    w.item_id,
    w.type_id,
    w.name,
    case when w.parent_id is not null and not exists (select 1 from walk x where x.depth = w.depth + 1)
         then null else coalesce(w.parent_id, w.place_id) end as location_id,
    case when w.parent_id is not null and not exists (select 1 from walk x where x.depth = w.depth + 1)
         then null else coalesce(w.parent_type, w.place_type) end as location_type,
    w.depth,
    (select t.name from public.sde_published_type t where t.type_id = w.type_id) as type_name
  from walk w
  order by w.depth;
$$;

-- A renamed table and a new relation: tell PostgREST now.
notify pgrst, 'reload schema';
