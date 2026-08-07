-- The asset index and solar-system pages call character_asset_location_summary()
-- and corp_asset_location_summary() to bucket the caller's hangar by location.
-- They cost 970 ms and 257 ms on production, in parallel and blocking, which is
-- what was left of the "1-2 second" asset navigation after 20260807000000.
--
-- Both build a `parent_of` CTE of one best-known parent per item across the
-- whole SCD history — 102,880 distinct item ids for the character table. But
-- only ids that appear as *somebody's location* can ever be looked up: the walk
-- probes `parent_of` by `w.location_id`, and the root test asks whether a
-- `w.location_id` is itself one of our items. There are 3,617 such ids, a
-- factor of 28 fewer.
--
-- Restricting the CTE to them is equivalence-preserving rather than an
-- approximation. Every id either side probes is by construction a location_id,
-- so an item that is a real parent necessarily appears as some row's
-- location_id and survives the filter; an item that never appears as anyone's
-- location could never have been probed. Verified on production: identical row
-- counts (1,482 character / 84 corp) with zero rows differing in either
-- direction.
--
--   character_asset_location_summary(): 970 ms -> 588 ms
--   corp_asset_location_summary():      257 ms -> 126 ms
--
-- This does not make the pages fast, and is not meant to — the functions still
-- walk every current asset up its container chain on every request, to produce
-- ~1.5k rows from data that only changes when the 6-hourly extract runs. The
-- fix for that is to stop recomputing it per request (a rollup table maintained
-- by the extract job); this is the cheap, verified half taken meanwhile.

create or replace function public.character_asset_location_summary()
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
    --
    -- Narrowed to ids that appear as some row's location: those are exactly the
    -- ids the walk and the root test below can probe, and there are ~28x fewer
    -- of them than there are distinct item ids.
    select distinct on (item_id) item_id, location_id, location_type
    from public.character_asset_over_time
    where item_id in (
      select location_id from public.character_asset_over_time where location_id is not null
    )
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

create or replace function public.corp_asset_location_summary()
returns table (location_id bigint, location_type text, corporation_id bigint, stacks bigint, station_name text, system_id bigint)
language sql
stable
as $$
  with recursive parent_of as (
    -- Same narrowing as the character version above.
    select distinct on (item_id) item_id, location_id, location_type
    from public.corp_asset_over_time
    where item_id in (
      select location_id from public.corp_asset_over_time where location_id is not null
    )
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
