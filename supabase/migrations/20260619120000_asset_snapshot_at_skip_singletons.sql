-- /api/assets exports one row per item stack and was flooded by singletons
-- (fitted modules, drones in drone bays, etc.) that don't roll up by quantity.
-- Drop singletons from the snapshot, but keep blueprint copies — they're
-- inherently singleton in EVE yet the player still wants them in the export.
-- BPOs come through with is_blueprint_copy=false (ESI omits the flag on
-- originals) so they fall under this filter too; distinguishing them would
-- require a type-category lookup we don't have in the DB.
create or replace function public.asset_snapshot_at(character_ids uuid[], as_of timestamptz)
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
  from public.asset_over_time a
  join public.registration r on r.id = a.character_id
  where a.character_id = any(character_ids)
    and a.first_seen_at <= as_of
    and (a.last_seen_at >= as_of or a.is_current)
    and (not a.is_singleton or a.is_blueprint_copy);
$$;

grant execute on function public.asset_snapshot_at(uuid[], timestamptz) to service_role;
