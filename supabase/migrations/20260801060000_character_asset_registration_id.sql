-- Rename character_asset_over_time.character_id to registration_id — the last
-- and widest tranche of step 5 of docs/registration-id-rename.md.
--
-- Assets were deliberately left until the end. Four functions read this family,
-- and they split into two kinds that need different treatment:
--
--   * character_asset_location_summary() and character_asset_search() publish
--     the column in their RETURNS TABLE. Renaming an output column is a
--     return-type change, so CREATE OR REPLACE refuses it and both must be
--     DROPped and recreated — the same thing that forced a drop for
--     latest_heartbeats() in #754, and unlike every function in #759/#760/#761.
--     These are also the only two renames in this whole cleanup that change a
--     contract JavaScript reads by name, so their callers move in this commit.
--
--   * character_asset_snapshot_at() returns json, so only its body moves and
--     CREATE OR REPLACE is enough.
--
-- Two more functions read the character_asset view but never name the renamed
-- column — character_asset_location_contents() and asset_ancestors(), which
-- climbs the character_asset ∪ corp_asset union. Both are left completely
-- alone: their bodies are re-parsed at execution against whatever the view
-- publishes, and neither selects the owner column. Verified by grep rather than
-- assumed, since asset_ancestors() is the one recursive CTE in the schema and
-- would be unpleasant to debug from a runtime failure.
--
-- The three function bodies below are reproduced verbatim from schema.sql
-- rather than hand-edited, the same technique as #761.
--
-- As throughout step 5, character_asset_snapshot_at()'s character_ids PARAMETER
-- stays: that is step 7, which ships with every RPC call site at once.

alter table public.character_asset_over_time rename column character_id to registration_id;

alter index if exists public.character_asset_over_time_character_id_idx
  rename to character_asset_over_time_registration_id_idx;

-- The view first: `select *` froze its output names at creation, and the
-- functions below resolve it when their bodies are parsed.
drop view if exists public.character_asset;
create view public.character_asset with (security_invoker = on) as
  select * from public.character_asset_over_time where is_current;
grant select on public.character_asset to authenticated;

-- Dropped rather than replaced — see the header. No policy calls either of
-- these (they are reached over RPC), so nothing has to be dropped ahead of them.
drop function if exists public.character_asset_location_summary();
create function public.character_asset_location_summary()
returns table (location_id bigint, location_type text, registration_id uuid, stacks bigint, station_name text, system_id bigint)
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
      a.registration_id  as registration_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.character_asset a
    union all
    select
      w.start_item,
      w.registration_id,
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
    w.registration_id,
    count(*) as stacks,
    st.name as station_name,
    st.system_id
  from walk w
  left join public.sde_station st on st.station_id = w.location_id
  where w.location_id is not null
    and not exists (select 1 from parent_of o where o.item_id = w.location_id)
  group by w.location_id, w.location_type, w.registration_id, st.name, st.system_id;
$$;

-- Re-granted because DROP discarded the ACL (schema.sql grants this one
-- explicitly; it is not covered by relying on default privileges alone).
grant execute on function public.character_asset_location_summary() to authenticated;

drop function if exists public.character_asset_search(bigint[]);
create function public.character_asset_search(type_ids bigint[])
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

grant execute on function public.character_asset_search(bigint[]) to authenticated;

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
  join public.registration r on r.id = a.registration_id
  left join public.sde_published_type t on t.type_id = a.type_id
  where a.registration_id = any(character_ids)
    and a.valid_from <= as_of
    and (a.is_current or a.valid_until >= as_of)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

grant execute on function public.character_asset_snapshot_at(uuid[], timestamptz) to service_role;

-- Assert every moving part. The two dropped-and-recreated functions are the
-- risk: a DROP that succeeds followed by a CREATE that quietly publishes the
-- wrong column name leaves the database working and the callers reading
-- undefined, which is precisely what the JavaScript half of this commit
-- depends on being right.
do $$
declare
  def text;
  fn text;
  n integer;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_asset'
      and column_name = 'character_id'
  ) then
    raise exception 'view character_asset still publishes character_id after the rename';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_asset'
      and column_name = 'registration_id'
  ) then
    raise exception 'view character_asset does not publish registration_id';
  end if;

  -- Output columns of the two RETURNS TABLE functions, read back from the
  -- catalog rather than from the text we just submitted.
  foreach fn in array array['character_asset_location_summary', 'character_asset_search'] loop
    select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    cross join unnest(p.proargnames) as arg
    where ns.nspname = 'public' and p.proname = fn and arg = 'registration_id';
    if n = 0 then
      raise exception '%() does not return a registration_id column', fn;
    end if;

    select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    cross join unnest(p.proargnames) as arg
    where ns.nspname = 'public' and p.proname = fn and arg = 'character_id';
    if n > 0 then
      raise exception '%() still returns a character_id column', fn;
    end if;
  end loop;

  foreach fn in array array['character_asset_location_summary', 'character_asset_search',
                            'character_asset_snapshot_at'] loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = fn;

    if def is null then
      raise exception 'function public.%() is missing after the rename', fn;
    end if;
    if def ~ '\m(a|w|m)\.character_id\M' then
      raise exception '%() body still references the old column — it would fail at its next call, not here', fn;
    end if;
  end loop;

  -- character_asset_snapshot_at keeps its parameter; losing it breaks every
  -- caller, since supabase-js passes RPC arguments by name.
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'character_asset_snapshot_at';
  if def not like '%character_ids%' then
    raise exception 'character_asset_snapshot_at() lost its character_ids parameter';
  end if;
end $$;
