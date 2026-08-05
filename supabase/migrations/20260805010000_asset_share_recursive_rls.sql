-- Phase 2 of the sharing layer's Revision 3 (docs/sharing-layer/02-recursive-rls.md):
-- the recursive widening policy on character_asset_over_time. A share on a ship
-- or container opens the item and everything inside it, to any depth, purely
-- through RLS — so the pages, MCP tools and GraphQL inherit shared visibility
-- by querying as the caller, and the SECURITY INVOKER walk RPCs
-- (asset_ancestors, *_location_contents, *_subtree_items) work for grantees
-- with no app-code changes.
--
-- THE ONE SANCTIONED SECURITY DEFINER. An invoker-rights helper selecting from
-- the table it is a policy on re-enters that policy and Postgres aborts with
-- "infinite recursion detected in policy" — the unresolved warning design.md
-- Stage E flagged. asset_share_covers() breaks the cycle as the single
-- exception to the no-definer invariant, and the exception is safe because it:
--   * returns a single boolean — it can never leak row data;
--   * reads only parentage columns (item_id, location_id) plus the share
--     table, matching audiences through asset_share_matches_caller(), whose
--     my_*_ids() calls still resolve auth.uid() to the CALLER inside a definer
--     context — so it grants exactly what the audience rules say;
--   * pins search_path and is revoked from public.
--
-- Shape: seeded from the share table, not from the candidate row. The caller-
-- matching shares BY THIS GRANTOR are collected first (the registration
-- parameter is what makes "no shares" the instant common case — a share can
-- only ever cover its grantor's own items, so rows of an unshared hangar
-- short-circuit on one indexed probe); only when any exist does the walk climb
-- from the item toward the root, one best-known-parent lateral step at a time
-- (the same bridge-snapshot-gaps ordering character_asset_location_summary()
-- uses), depth-capped at 16 to match asset_ancestors().
create or replace function public.asset_share_covers(item bigint, registration uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.item_id
      from character_asset_share s
      where s.registration_id = asset_share_covers.registration
        and asset_share_matches_caller(s.corporation_ids, s.alliance_ids, s.secret)
    ),
    walk (node, depth) as (
      select asset_share_covers.item, 0
      union all
      select parent.location_id, w.depth + 1
      from walk w
      cross join lateral (
        select o.location_id
        from character_asset_over_time o
        where o.item_id = w.node
        order by o.is_current desc, o.valid_until desc
        limit 1
      ) parent
      where w.depth < 16
        and parent.location_id is not null
        and exists (select 1 from matching_shares)
    )
  select exists (
    select 1
    from walk w
    join matching_shares m on m.item_id = w.node
  );
$$;

revoke execute on function public.asset_share_covers(bigint, uuid) from public;
grant execute on function public.asset_share_covers(bigint, uuid) to anon, authenticated;

-- The widening policy. is_current keeps SCD-2 history closed: a share opens
-- the CURRENT view only — the same rows character_asset shows the owner.
-- Permissive, so it ORs with "Users read own assets". `to anon` so a
-- fully-public share is readable signed-out.
create policy "Audience reads shared assets"
  on public.character_asset_over_time
  for select
  to anon, authenticated
  using (is_current and public.asset_share_covers(item_id, registration_id));

-- anon had no select on the asset table/view before; RLS still scopes anon to
-- rows a public share covers (the owner policy never matches a null uid).
grant select on public.character_asset_over_time to anon;
grant select on public.character_asset           to anon;
