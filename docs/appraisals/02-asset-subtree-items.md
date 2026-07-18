# 02 — Subtree item-aggregation Postgres functions

Small DB-only PR. Adds the two functions the asset-viewer appraisal (doc 03)
needs: given a container/ship item id **or** a bare location id (station /
structure / solar system), return everything inside it — the whole nested
subtree — aggregated to `(type_id, quantity)` rows ready to be priced.
Independent of doc 01; can land in parallel.

## Why a new function shape

The existing walk functions almost fit but don't:

- `character_asset_location_contents(parent)` (`schema.sql`) does exactly the
  right **descend** over `location_id` chains, but returns per-child counts,
  not type/quantity aggregates.
- `character_asset_search(type_ids[])` descends too, but is seeded by type
  filter, not by location.

Per the design-pattern note in CLAUDE.md, this is a **seeded recursion**: it
starts from one parent id and touches only that subtree, so it stays cheap
regardless of hangar size.

## The functions

Dual-write: add to `schema.sql` (next to
`character_asset_location_contents`, reusing its style) **and** as one new
migration via `pnpm run db:new asset_subtree_items`. Never rename existing
migration files.

```sql
-- Appraisal support (/asset/[locationId], doc 03): every item in the subtree
-- under `parent` — a container/ship item id or a bare location id — summed
-- into one row per item type. Singletons (assembled ships, containers)
-- count as quantity 1. Seeded from `parent` only, so cost scales with the
-- subtree, not the hangar (cf. character_asset_search's descend CTE).
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
  select type_id, sum(case when is_singleton then 1 else coalesce(quantity, 1) end)::bigint as quantity
  from descend
  group by type_id;
$$;
```

`corp_asset_subtree_items(parent bigint)` is the identical query over
`public.corp_asset` (mirroring how every character/corp function pair in
`schema.sql` is structured — put it next to
`corp_asset_location_contents`).

Grants, matching the neighbors:

```sql
grant execute on function public.character_asset_subtree_items(bigint) to authenticated;
grant execute on function public.corp_asset_subtree_items(bigint)      to authenticated;
```

Both query the `character_asset` / `corp_asset` **views** (not the
`_over_time` tables), so RLS scopes results to the caller exactly like the
existing functions — a service-role caller would walk unscoped, so doc 03's
route must use the cookie-session client only (it does; the share-token path
gets no appraisal button).

## Decisions baked in (don't relitigate in the PR)

- **The parent itself is excluded.** The function returns strictly the
  contents. When the appraisal target is an item (a ship or container), the
  caller adds the parent's own `(type_id, 1)` line — it already has that
  row in hand. When the target is a bare location, there is nothing to add.
- **Quantity semantics** match the MCP `search_assets` mapping: singleton
  rows (assembled ships, containers, fitted modules) are 1 apiece;
  otherwise `coalesce(quantity, 1)`.
- **No filtering in SQL.** Blueprint exclusion (BPCs are indistinguishable
  from BPOs in asset rows and would mis-price) happens app-side via the SDE
  category lookup — doc 03 owns that. The function reports the raw truth.
- **Depth cap 64**, same as every other walk in `schema.sql`.

## Verification

1. `pnpm run lint` / `pnpm run build` (unchanged code paths, but the gates
   always run).
2. Apply the migration to the linked project (`pnpm run db:push`) or let the
   `Migrate` workflow do it on merge.
3. Sanity-check in SQL (as an authenticated user via the app or the SQL
   editor impersonating one): pick a ship with fitted modules + cargo from
   `/asset`, run `select * from character_asset_subtree_items(<item_id>)`,
   and eyeball the rows against the `/ship/[itemId]` page. Confirm a bare
   station id returns that hangar's aggregate, and an id you don't own
   returns zero rows.
