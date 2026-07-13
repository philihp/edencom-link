-- Rename the SCD Type 2 validity columns first_seen_at → valid_from and
-- last_seen_at → valid_until across every *_over_time history table, so the
-- temporal interval each version is valid for reads as an explicit validity
-- window (is_current still flags the open row). Straight rename — the reconcile
-- semantics are unchanged: valid_from marks a version's debut, valid_until is
-- extended each run the row is seen unchanged. corp_structure keeps its own
-- last_seen_at (a plain live-table "last seen in the listing" stamp, not an SCD
-- validity column) and is deliberately untouched.
--
-- A column rename does not rewrite the old-style SQL function bodies that read
-- these columns, so the five asset-walk/snapshot functions are recreated with
-- the new names afterward (views are select * and update automatically).

alter table public.character_asset_over_time rename column first_seen_at to valid_from;
alter table public.character_asset_over_time rename column last_seen_at to valid_until;
alter table public.character_blueprint_over_time rename column first_seen_at to valid_from;
alter table public.character_blueprint_over_time rename column last_seen_at to valid_until;
alter table public.character_clone_over_time rename column first_seen_at to valid_from;
alter table public.character_clone_over_time rename column last_seen_at to valid_until;
alter table public.character_ship_over_time rename column first_seen_at to valid_from;
alter table public.character_ship_over_time rename column last_seen_at to valid_until;
alter table public.character_order_over_time rename column first_seen_at to valid_from;
alter table public.character_order_over_time rename column last_seen_at to valid_until;
alter table public.character_industry_job_over_time rename column first_seen_at to valid_from;
alter table public.character_industry_job_over_time rename column last_seen_at to valid_until;
alter table public.corp_asset_over_time rename column first_seen_at to valid_from;
alter table public.corp_asset_over_time rename column last_seen_at to valid_until;
alter table public.corp_blueprint_over_time rename column first_seen_at to valid_from;
alter table public.corp_blueprint_over_time rename column last_seen_at to valid_until;
alter table public.corp_industry_job_over_time rename column first_seen_at to valid_from;
alter table public.corp_industry_job_over_time rename column last_seen_at to valid_until;

-- ── recreate the functions that read the renamed columns ──────────────────

create or replace function public.character_asset_location_summary()
returns table (location_id bigint, location_type text, character_id uuid, stacks bigint)
language sql
stable
as $$
  with recursive parent_of as (
    -- One best-known parent per item the caller can see: the live row if there is
    -- one, otherwise the most recent historical sighting. The walk climbs through
    -- this rather than the live-only character_asset view so it can bridge a
    -- container or ship that has momentarily dropped out of the current snapshot
    -- — e.g. one handed between the player's own characters, whose per-character
    -- extracts run at different times — and still roll its contents up to the
    -- enclosing structure instead of stranding them on the bare item id. RLS
    -- keeps character_asset_over_time scoped to the caller's own characters, so
    -- a container owned by someone else (a corpmate's) still can't be bridged.
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    order by item_id, is_current desc, valid_until desc
  ),
  walk as (
    select
      a.item_id       as start_item,
      a.character_id  as character_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.character_asset a
    union all
    select
      w.start_item,
      w.character_id,
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
    w.character_id,
    count(*) as stacks
  from walk w
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.character_id;
$$;

create or replace function public.character_asset_search(type_ids bigint[])
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
  contents bigint
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
    coalesce(ct.contents, 0) as contents
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id;
$$;

create or replace function public.character_asset_snapshot_at(character_ids uuid[], as_of timestamptz)
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'is_blueprint_copy', a.is_blueprint_copy,
        'is_singleton',      a.is_singleton,
        'item_id',           a.item_id,
        'location_flag',     a.location_flag,
        'location_id',       a.location_id,
        'location_type',     a.location_type,
        'quantity',          a.quantity,
        'type_id',           a.type_id,
        'character_name',    r.name
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.character_asset_over_time a
  join public.registration r on r.id = a.character_id
  where a.character_id = any(character_ids)
    and a.valid_from <= as_of
    and (a.valid_until >= as_of or a.is_current)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

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
    order by item_id, is_current desc, valid_until desc
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
  contents bigint
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
    coalesce(ct.contents, 0) as contents
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id;
$$;
