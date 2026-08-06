-- The asset viewer's table now selects rows (checkboxes + a drag rectangle)
-- and appraises the selection as one batch. A selection is many item ids, and
-- the existing character_asset_subtree_items(bigint) walks exactly one — so
-- pricing a 40-row selection would mean 80 round trips, against a provider
-- budget that only ever allows the one upstream call. Add an array-taking
-- overload of each walk so a whole selection descends in a single query.
--
-- Both are SECURITY INVOKER over the character_asset / corp_asset views, like
-- the scalar versions they sit beside, so RLS scopes the walk to the caller's
-- own items. The scalar overloads stay: the MCP appraise_assets tool and the
-- "appraise everything here" header button still ask about one place.
--
-- Two things the scalar version never had to think about, both of which a
-- selection can genuinely contain — a container and something inside it:
--   * an item reached by two different parents' descents is folded once
--     (distinct on item_id), not counted twice;
--   * an item that is itself one of the parents is dropped here, because the
--     caller adds a line for every target it resolved — otherwise the nested
--     target would be priced both as a target and as its parent's content.

create or replace function public.character_asset_subtree_items(parents bigint[])
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.character_asset a
    where a.location_id = any(parents)
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.character_asset c on c.location_id = d.item_id
    where d.depth < 64
  ),
  once as (
    select distinct on (item_id) item_id, type_id, quantity, is_singleton
    from descend
    order by item_id
  )
  select
    o.type_id,
    sum(case when o.is_singleton then 1 else coalesce(o.quantity, 1) end)::bigint as quantity
  from once o
  where o.item_id <> all(parents)
  group by o.type_id;
$$;

create or replace function public.corp_asset_subtree_items(parents bigint[])
returns table (type_id bigint, quantity bigint)
language sql
stable
as $$
  with recursive descend as (
    select a.item_id, a.type_id, a.quantity, a.is_singleton, 1 as depth
    from public.corp_asset a
    where a.location_id = any(parents)
    union all
    select c.item_id, c.type_id, c.quantity, c.is_singleton, d.depth + 1
    from descend d
    join public.corp_asset c on c.location_id = d.item_id
    where d.depth < 64
  ),
  once as (
    select distinct on (item_id) item_id, type_id, quantity, is_singleton
    from descend
    order by item_id
  )
  select
    o.type_id,
    sum(case when o.is_singleton then 1 else coalesce(o.quantity, 1) end)::bigint as quantity
  from once o
  where o.item_id <> all(parents)
  group by o.type_id;
$$;

grant execute on function public.character_asset_subtree_items(bigint[]) to authenticated;
grant execute on function public.corp_asset_subtree_items(bigint[])      to authenticated;
