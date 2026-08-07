-- Two fixes for the asset browser's page load, both measured against production
-- on /asset/1049965150127 (a Station Warehouse Container holding 934 items).
--
-- 1. asset_ancestors() took 3,199 ms — and it is awaited before the page's
--    first byte, so it was essentially the whole of that page's TTFB.
-- 2. Nothing indexes location_id, so every "what is at this location" query
--    scanned the entire current asset snapshot.

-- ---------------------------------------------------------------------------
-- 1. The location_id indexes.
--
-- character_asset_over_time holds 281k rows (91,770 of them current) and
-- corp_asset_over_time 57k (25,199 current), and every location-scoped query
-- read all of them:
--
--   * the root-item query behind /asset/[locationId] read 91,770 rows to
--     return 934 — 34 ms, now 1.1 ms;
--   * character_asset_location_contents() took 128 ms, 94 ms of which was an
--     external merge sort spilling 2.3 MB to disk in order to compute a
--     recursive join that returned *zero* rows — nothing in that container is
--     nested inside anything else, but without an index Postgres had to sort
--     the whole table to find that out. Now 65-75 ms: the disk sort is gone
--     (the index supplies location_id order, so the merge join needs no sort)
--     and the base case drops 31 ms -> 1.6 ms. The rest is the recursive step
--     still reading the whole index to feed that merge join, because the
--     planner estimates the descend CTE at 1.2M rows against an actual 934.
--     Worth another look, but it is no longer the page's problem.
--   * corp_asset_location_contents(): 13.7 ms -> 0.06 ms.
--
-- Partial, matching the `where is_current` predicate of the character_asset /
-- corp_asset views every one of those queries actually goes through: the
-- history rows are never location-filtered, so indexing them would only make
-- the index bigger and the extract's writes slower.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: the Supabase CLI runs a
-- migration inside a transaction, which CONCURRENTLY cannot join. These tables
-- are 82 MB and 16 MB, so the build takes about a second, and the extract jobs
-- that write them are the only thing the lock can block.
create index if not exists character_asset_over_time_current_location_idx
  on public.character_asset_over_time (location_id) where is_current;
create index if not exists corp_asset_over_time_current_location_idx
  on public.corp_asset_over_time (location_id) where is_current;

-- ---------------------------------------------------------------------------
-- 2. asset_ancestors(): 3,199 ms -> 73 ms.
--
-- The breadcrumb walk for /asset/[locationId] and /ship/[itemId]. Same
-- signature, same rows (verified equal over 26 sampled ids); only the plan
-- changes. Two independent problems compounded:
--
-- (a) `parent_of` is referenced twice — once by the base term, once by the
--     recursive one — so Postgres materialized it instead of inlining it:
--     all 116,969 current character+corp asset rows were built into a temp
--     result and then filtered down to one (`Rows Removed by Filter: 116,968`),
--     with the item_id index that would have answered it instantly unused.
--     `not materialized` restores the index seek (0.07 ms for the base term).
--
-- (b) The type name came from `left join public.sde_published_type`. The
--     recursive CTE's row estimate is 41,202 against an actual of 1, so the
--     planner chose a hash join and built the hash from the whole view — a
--     sequential scan of sde_types decompressing and parsing 52,848 jsonb
--     documents, 2,955 ms cold and ~600 ms warm, to label a single row. As a
--     scalar subquery it is one index probe per output row (0.15 ms), and a
--     row estimate this wrong can no longer choose a catastrophic plan.
--     sde_published_type is keyed on _key, so at most one row matches and the
--     subquery is exactly equivalent to the left join it replaces.
--
-- Both plans were measured on production inside a transaction that was rolled
-- back. The 72 ms that remains is the recursive step scanning the full
-- character+corp append rather than probing the item_id index — the same bad
-- recursive-CTE row estimate as in (b), just no longer expensive enough to
-- matter next to a 3.2 s page.
create or replace function public.asset_ancestors(start_id bigint)
returns table (item_id bigint, type_id bigint, name text, location_id bigint, location_type text, depth int, type_name text)
language sql
stable
as $$
  with recursive parent_of as not materialized (
    select item_id, type_id, name, location_id, location_type
    from public.character_asset
    union all
    select item_id, type_id, null::text as name, location_id, location_type
    from public.corp_asset
  ),
  walk as (
    select p.item_id, p.type_id, p.name, p.location_id, p.location_type, 1 as depth
    from parent_of p
    where p.item_id = start_id
    union all
    select p.item_id, p.type_id, p.name, p.location_id, p.location_type, w.depth + 1
    from walk w
    join parent_of p on p.item_id = w.location_id
    where w.depth < 16
  )
  select
    w.item_id,
    w.type_id,
    w.name,
    w.location_id,
    w.location_type,
    w.depth,
    (select t.name from public.sde_published_type t where t.type_id = w.type_id) as type_name
  from walk w
  order by w.depth;
$$;

grant execute on function public.asset_ancestors(bigint) to authenticated;
