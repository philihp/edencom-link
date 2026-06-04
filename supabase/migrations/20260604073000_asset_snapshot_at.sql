-- The /api/assets ImportJSON endpoint now returns the raw asset rows (one per
-- item stack) with the owning character's name, instead of a by-type total.
-- asset_snapshot_at supersedes asset_inventory_at: it reconstructs the SCD-2
-- snapshot as of `as_of` and returns the whole result as a single jsonb array, so
-- PostgREST's max-rows cap never truncates it and the rollup/paging stays in
-- Postgres (what keeps the endpoint under Vercel's timeout).
drop function if exists public.asset_inventory_at(uuid[], timestamptz);

create or replace function public.asset_snapshot_at(character_ids uuid[], as_of timestamptz)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
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
    '[]'::jsonb
  )
  from public.asset_over_time a
  join public.registration r on r.id = a.character_id
  where a.character_id = any(character_ids)
    and a.first_seen_at <= as_of
    and (a.last_seen_at >= as_of or a.is_current);
$$;

grant execute on function public.asset_snapshot_at(uuid[], timestamptz) to service_role;
