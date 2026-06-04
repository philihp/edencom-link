-- ImportJSON renders the sheet's columns in the order the JSON keys appear, but
-- jsonb normalizes (reorders) object keys, so the columns came out scrambled.
-- Switch asset_snapshot_at to the json type, which preserves the key order in
-- json_build_object below. Changing a function's return type needs a drop first.
drop function if exists public.asset_snapshot_at(uuid[], timestamptz);

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
    and (a.last_seen_at >= as_of or a.is_current);
$$;

grant execute on function public.asset_snapshot_at(uuid[], timestamptz) to service_role;
