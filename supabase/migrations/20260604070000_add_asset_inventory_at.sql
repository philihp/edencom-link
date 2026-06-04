-- Postgres-side aggregation for the /api/assets ImportJSON endpoint: the player's
-- total inventory summed by item type as of `at`, reconstructed from the SCD-2
-- history in asset_over_time. Doing the rollup here (instead of paging every raw
-- row into the serverless function) is what keeps the endpoint under Vercel's
-- timeout. Called with the service role over the caller's own registration ids.
create or replace function public.asset_inventory_at(character_ids uuid[], as_of timestamptz)
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  select a.type_id, sum(coalesce(a.quantity, 1))::bigint as quantity
  from public.asset_over_time a
  where a.character_id = any(character_ids)
    and a.first_seen_at <= as_of
    and (a.last_seen_at >= as_of or a.is_current)
  group by a.type_id;
$$;

grant execute on function public.asset_inventory_at(uuid[], timestamptz) to service_role;
