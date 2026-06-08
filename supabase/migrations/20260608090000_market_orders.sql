-- /api/orders IMPORTDATA endpoint: the player's open market orders across all of
-- their characters, with the owning character's name. Returns the whole result as
-- a single json array (json, not jsonb, so json_build_object's key order is
-- preserved for the sheet's columns) and sidesteps PostgREST's max-rows cap. The
-- stored `is_buy` flag is exposed as `is_buy_order` to match ESI's field name.
-- Called with the service role over the caller's own registration ids.
create or replace function public.market_orders(character_ids uuid[])
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
        'character_name', r.name
      )
      order by o.issued desc
    ),
    '[]'::json
  )
  from public.market_order o
  join public.registration r on r.id = o.character_id
  where o.character_id = any(character_ids);
$$;

grant execute on function public.market_orders(uuid[]) to service_role;
