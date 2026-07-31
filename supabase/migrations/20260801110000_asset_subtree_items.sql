-- Price appraisals in the asset viewer (docs/appraisals/03) need to send a
-- whole container, ship or hangar to innomin.at as one batch of
-- (type, quantity) lines — the rate limit is 200 requests/hour, so an
-- appraisal is one API call over an aggregate, never a call per item. The
-- existing walk functions don't produce that aggregate: location_contents()
-- descends correctly but returns per-child counts, and asset_search() is
-- seeded by type filter rather than by location. Add the missing shape for
-- both owner scopes. Both are SECURITY INVOKER over the character_asset /
-- corp_asset views, so RLS scopes the walk to the caller's own items exactly
-- like the neighbors.

-- appraisal (/asset/[locationId]): everything inside `parent` — a container or
-- ship item id, or a bare location id (station, structure, solar system) —
-- summed into one row per item type, ready to be priced. The parent itself is
-- excluded, so a caller appraising an item adds its own (type_id, 1) line;
-- appraising a bare location has nothing to add. Singletons (assembled ships,
-- containers, fitted modules) count as 1 apiece, the same reading of a stack
-- the asset pages and MCP tools use. Reports the raw contents: blueprint
-- copies price like originals here, and callers that care drop them by type.
-- Seeded from `parent` alone, so cost scales with the subtree rather than the
-- hangar (cf. character_asset_search).
create or replace function public.character_asset_subtree_items(parent bigint)
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.character_asset a
    where a.location_id = parent
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.item_id
    where d.depth < 64
  )
  select
    d.type_id,
    sum(case when d.is_singleton then 1 else coalesce(d.quantity, 1) end)::bigint as quantity
  from descend d
  group by d.type_id;
$$;

-- The same over corp assets.
create or replace function public.corp_asset_subtree_items(parent bigint)
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.corp_asset a
    where a.location_id = parent
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.corp_asset c on c.location_id = d.item_id
    where d.depth < 64
  )
  select
    d.type_id,
    sum(case when d.is_singleton then 1 else coalesce(d.quantity, 1) end)::bigint as quantity
  from descend d
  group by d.type_id;
$$;

grant execute on function public.character_asset_subtree_items(bigint) to authenticated;
grant execute on function public.corp_asset_subtree_items(bigint)      to authenticated;
