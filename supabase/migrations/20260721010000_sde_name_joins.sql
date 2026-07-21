-- JOIN the nightly-mirrored SDE views into the extract Postgres functions so
-- the CSV/Sheets export endpoints and the asset search/breadcrumb RPCs carry
-- human-readable names, not just raw ids (SDE-to-database cutover, doc 02).
--
-- All additions are new columns appended at the END of each result row: the
-- CSV endpoints feed Google Sheets IMPORTDATA formulas that reference columns
-- by position, so inserting a column mid-row would silently break users'
-- spreadsheets. New name columns always go last.
--
-- JOIN targets are the app-shaped views over the sde_* mirror, never the raw
-- jsonb tables:
--   type names   → sde_published_type (type_id → name)
--   NPC stations → sde_station (station_id → name, system_id)
-- Always LEFT JOIN with the name possibly NULL — unpublished types, wormhole
-- systems, and player structures won't match, and every caller's existing
-- raw-id fallback keeps working. The views are security_invoker over
-- RLS-enabled tables whose only policy is public SELECT, so they're safe to
-- reference from these existing SECURITY INVOKER functions for any caller.

-- ── CSV / Sheets snapshot functions (return json; keys append at the end) ──

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
        'character_name',    r.name,
        'type_name',         t.name
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.character_asset_over_time a
  join public.registration r on r.id = a.character_id
  left join public.sde_published_type t on t.type_id = a.type_id
  where a.character_id = any(character_ids)
    and a.valid_from <= as_of
    and (a.is_current or a.valid_until >= as_of)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

create or replace function public.character_blueprints(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id,
        'character_name',      r.name,
        'type_name',           t.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.character_blueprint b
  join public.registration r on r.id = b.character_id
  left join public.sde_published_type t on t.type_id = b.type_id
  where b.character_id = any(character_ids);
$$;

create or replace function public.character_orders(character_ids uuid[], as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'duration',       o.duration,
        'escrow',         o.escrow,
        'is_buy_order',   o.is_buy,
        'is_corporation', o.is_corporation,
        'issued',         o.issued,
        'location_id',    o.location_id,
        'min_volume',     o.min_volume,
        'order_id',       o.order_id,
        'price',          o.price,
        'range',          o.range,
        'region_id',      o.region_id,
        'type_id',        o.type_id,
        'volume_remain',  o.volume_remain,
        'volume_total',   o.volume_total,
        'character_name', r.name,
        'type_name',      t.name
      )
      order by o.issued desc
    ),
    '[]'::json
  )
  from public.character_order_over_time o
  join public.registration r on r.id = o.character_id
  left join public.sde_published_type t on t.type_id = o.type_id
  where o.character_id = any(character_ids)
    and o.valid_from <= as_of
    and (o.is_current or o.valid_until >= as_of);
$$;

create or replace function public.character_industry_jobs(character_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'activity_id',            j.activity_id,
        'blueprint_id',           j.blueprint_id,
        'blueprint_location_id',  j.blueprint_location_id,
        'blueprint_type_id',      j.blueprint_type_id,
        'completed_character_id', j.completed_character_id,
        'completed_date',         j.completed_date,
        'cost',                   j.cost,
        'duration',               j.duration,
        'end_date',               j.end_date,
        'facility_id',            j.facility_id,
        'installer_id',           j.installer_id,
        'job_id',                 j.job_id,
        'licensed_runs',          j.licensed_runs,
        'output_location_id',     j.output_location_id,
        'pause_date',             j.pause_date,
        'probability',            j.probability,
        'product_type_id',        j.product_type_id,
        'runs',                   j.runs,
        'start_date',             j.start_date,
        'station_id',             j.station_id,
        'status',                 j.status,
        'successful_runs',        j.successful_runs,
        'character_name',         r.name,
        'blueprint_type_name',    bt.name,
        'product_type_name',      pt.name
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.character_industry_job_over_time j
  join public.registration r on r.id = j.character_id
  left join public.sde_published_type bt on bt.type_id = j.blueprint_type_id
  left join public.sde_published_type pt on pt.type_id = j.product_type_id
  where j.character_id = any(character_ids)
    and j.valid_from <= as_of
    and (j.is_current or j.valid_until >= as_of)
    and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

create or replace function public.corp_assets(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',           a.item_id,
        'corporation_id',    a.corporation_id,
        'type_id',           a.type_id,
        'location_id',       a.location_id,
        'location_flag',     a.location_flag,
        'location_type',     a.location_type,
        'quantity',          a.quantity,
        'is_singleton',      a.is_singleton,
        'is_blueprint_copy', a.is_blueprint_copy,
        'type_name',         t.name
      )
      order by a.item_id
    ),
    '[]'::json
  )
  from public.corp_asset a
  left join public.sde_published_type t on t.type_id = a.type_id
  where a.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  );
$$;

create or replace function public.corp_blueprints(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'item_id',             b.item_id,
        'corporation_id',      b.corporation_id,
        'location_flag',       b.location_flag,
        'location_id',         b.location_id,
        'material_efficiency', b.material_efficiency,
        'quantity',            b.quantity,
        'runs',                b.runs,
        'time_efficiency',     b.time_efficiency,
        'type_id',             b.type_id,
        'type_name',           t.name
      )
      order by b.item_id
    ),
    '[]'::json
  )
  from public.corp_blueprint b
  left join public.sde_published_type t on t.type_id = b.type_id
  where b.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  );
$$;

create or replace function public.corp_industry_jobs(character_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'activity_id',            j.activity_id,
        'blueprint_id',           j.blueprint_id,
        'blueprint_location_id',  j.blueprint_location_id,
        'blueprint_type_id',      j.blueprint_type_id,
        'completed_character_id', j.completed_character_id,
        'completed_date',         j.completed_date,
        'corporation_id',         j.corporation_id,
        'cost',                   j.cost,
        'duration',               j.duration,
        'end_date',               j.end_date,
        'facility_id',            j.facility_id,
        'installer_id',           j.installer_id,
        'job_id',                 j.job_id,
        'licensed_runs',          j.licensed_runs,
        'output_location_id',     j.output_location_id,
        'pause_date',             j.pause_date,
        'probability',            j.probability,
        'product_type_id',        j.product_type_id,
        'runs',                   j.runs,
        'start_date',             j.start_date,
        'station_id',             j.station_id,
        'status',                 j.status,
        'successful_runs',        j.successful_runs,
        'blueprint_type_name',    bt.name,
        'product_type_name',      pt.name
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.corp_industry_job_over_time j
  left join public.sde_published_type bt on bt.type_id = j.blueprint_type_id
  left join public.sde_published_type pt on pt.type_id = j.product_type_id
  where j.corporation_id in (
    select corporation_id from public.registration
    where id = any(character_ids) and corporation_id is not null
  )
  and j.valid_from <= as_of
  and (j.is_current or j.valid_until >= as_of)
  and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

-- ── Asset search + breadcrumb + rollup (return table; changing the returns
-- signature needs a drop first, and drop discards grants, so re-grant) ──

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
  system_id bigint
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
    st.system_id
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id;
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
  system_id bigint
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
    st.system_id
  from matched m
  join roots r on r.start_item = m.item_id
  left join contents ct on ct.ancestor = m.item_id
  left join public.sde_published_type t on t.type_id = m.type_id
  left join public.sde_station st on st.station_id = r.root_location_id;
$$;
grant execute on function public.corp_asset_search(bigint[]) to authenticated;

drop function if exists public.asset_ancestors(bigint) cascade;
create function public.asset_ancestors(start_id bigint)
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int, type_name text)
language sql
stable
as $$
  with recursive parent_of as (
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
  select w.item_id, w.type_id, w.name, w.location_id, w.location_type, w.depth, t.name as type_name
  from walk w
  left join public.sde_published_type t on t.type_id = w.type_id
  order by w.depth;
$$;
grant execute on function public.asset_ancestors(bigint) to authenticated;

drop function if exists public.character_asset_location_summary() cascade;
create function public.character_asset_location_summary()
returns table (location_id bigint, location_type text, character_id uuid, stacks bigint, station_name text, system_id bigint)
language sql
stable
as $$
  with recursive parent_of as (
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
    count(*) as stacks,
    st.name as station_name,
    st.system_id
  from walk w
  left join public.sde_station st on st.station_id = w.location_id
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.character_id, st.name, st.system_id;
$$;
grant execute on function public.character_asset_location_summary() to authenticated;

drop function if exists public.corp_asset_location_summary() cascade;
create function public.corp_asset_location_summary()
returns table (location_id bigint, location_type text, corporation_id bigint, stacks bigint, station_name text, system_id bigint)
language sql
stable
as $$
  with recursive parent_of as (
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
    count(*) as stacks,
    st.name as station_name,
    st.system_id
  from walk w
  left join public.sde_station st on st.station_id = w.location_id
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.corporation_id, st.name, st.system_id;
$$;
grant execute on function public.corp_asset_location_summary() to authenticated;
