-- asset_location_summary() climbed each item up its location_id chain through
-- the live `asset` view only, so when an intermediate container or ship was
-- momentarily absent from the current snapshot — e.g. handed between the
-- player's own characters, whose per-character extracts run at different times —
-- the walk stranded that item's contents on the bare container/ship id, which
-- the assets page then rendered as a raw "Location #<id>" instead of folding it
-- into the enclosing structure.
--
-- Climb through a best-known-parent CTE (the live row per item if present, else
-- the most recent historical sighting) so the chain can bridge that gap and roll
-- the contents up to the structure. RLS still scopes asset_over_time to the
-- caller's own characters, so a container owned by someone else can't be bridged.
create or replace function public.asset_location_summary()
returns table (location_id bigint, location_type text, character_id uuid, stacks bigint)
language sql
stable
as $$
  with recursive parent_of as (
    select distinct on (item_id) item_id, location_id, location_type
    from public.asset_over_time
    order by item_id, is_current desc, last_seen_at desc
  ),
  walk as (
    select
      a.item_id       as start_item,
      a.character_id  as character_id,
      a.location_id   as location_id,
      a.location_type as location_type,
      1               as depth
    from public.asset a
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

grant execute on function public.asset_location_summary() to authenticated;
