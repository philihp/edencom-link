-- Phase 14, PR 3 of the sharing layer (docs/sharing-layer/14-corp-asset-share.md):
-- the recursive widening policy on corp_asset_version. A corp share on an
-- office, container or ship opens the item and everything inside it, to any
-- depth, purely through RLS — so the pages, MCP tools and GraphQL inherit
-- shared visibility by querying as the caller, and the SECURITY INVOKER walk
-- RPCs (asset_ancestors, corp_asset_location_contents,
-- corp_asset_subtree_items) work for grantees with no app-code changes. The
-- corp twin of 02-recursive-rls.md, on PR 1's split table.
--
-- NOT the per-row twin of asset_share_covers(item, registration), which the
-- plan called for: that shape climbs from the candidate row, so the policy runs
-- a recursive walk for every row the member policy does not already grant. Phase
-- 11 recorded that cost on the character table (~2.3 s per scan) and accepted
-- it; measured here it put a member's unfiltered corp_asset read at 5.1 s and
-- the live corp_asset_location_summary() — which MCP browse_assets calls — at
-- 12.5 s, past the 8 s statement_timeout the `authenticated` role carries. The
-- numbers are in the doc.
--
-- So the walk runs ONCE per query and descends instead: corp_shared_item_ids()
-- returns every item id the caller's visible shares cover, and the policy is a
-- set membership. Being argument-free and stable, the planner evaluates it once
-- into a hashed subplan rather than per row (same shape as
-- my_tenant_structure_ids() in the co-tenant job policies). Worst case measured
-- — every corporation holding a share — the summary stays at 159 ms against a
-- 121 ms baseline.
--
-- Testing item_id ALONE is sound because corp_asset_version_current_item_idx is
-- unique on (item_id) where is_current across every corporation: no two current
-- rows share an item id, and the policy grants current rows only. So an id in
-- the covered set identifies exactly one row, and a share can never reach
-- another corporation's hangar.
--
-- STILL A SANCTIONED SECURITY DEFINER, for phase 02's reason: an invoker-rights
-- helper selecting from the table it is a policy on re-enters that policy and
-- Postgres aborts with "infinite recursion detected in policy". The exception
-- stays safe because the function:
--   * returns only item ids the policy is about to grant the caller — it is the
--     grant itself, not a window past it;
--   * reads only parentage columns (item_id, location_id, corporation_id) plus
--     the share table, matching audiences through share_audience_matches(),
--     whose my_*_ids() calls still resolve auth.uid() to the CALLER inside a
--     definer context;
--   * pins search_path and is revoked from public.
--
-- Note what it does NOT read: corp_asset_location. The walk follows parent
-- links, so a shared root's place is never touched and a recipient reads
-- location_id null through the views (sharing the place is a phase non-goal).
--
-- Two further notes on the descent:
--   * it stays inside the grantor corporation (c.corporation_id = w.corporation_id),
--     so a corp's share cannot be extended by another corp's item claiming one
--     of its items as a parent — the nine such rows production holds are roots
--     by the same-owner rule;
--   * it follows CURRENT children only, where the upward walk took each item's
--     best-known parent and so bridged a container that momentarily dropped out
--     of the snapshot. The policy grants current rows either way; the
--     difference is that an item whose container has no current row is not
--     covered until the next extract restores it.
create or replace function public.corp_shared_item_ids()
returns setof bigint
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.corporation_id, s.item_id
      from corp_asset_share s
      where share_audience_matches(s.corporation_ids, s.alliance_ids, s.secret)
    ),
    walk (corporation_id, node, depth) as (
      select m.corporation_id, m.item_id, 0
      from matching_shares m
      union all
      select w.corporation_id, c.item_id, w.depth + 1
      from walk w
      join corp_asset_version c
        on c.location_id = w.node
       and c.corporation_id = w.corporation_id
       and c.is_current
      -- Depth 16 of descent, matching the 16 climbs asset_ancestors() and
      -- asset_share_covers() cap at.
      where w.depth < 16
    )
  select distinct node from walk;
$$;

revoke execute on function public.corp_shared_item_ids() from public;
grant execute on function public.corp_shared_item_ids() to anon, authenticated;

-- The widening policy. is_current keeps SCD-2 history closed: a share opens the
-- CURRENT view only — the same rows corp_asset shows a member. Permissive, so
-- it ORs with "Users read assets for own corps". `to anon` so a fully-public
-- share is readable signed-out.
create policy "Audience reads shared corp assets"
  on public.corp_asset_version
  for select
  to anon, authenticated
  using (is_current and item_id in (select public.corp_shared_item_ids()));

-- anon had no select on the corp asset table or its views before; RLS still
-- scopes anon to rows a public share covers (the member policy never matches a
-- null uid). corp_asset_location already holds the grant with no policy, from
-- PR 1 — which is what keeps a view anon may read from failing on it.
grant select on public.corp_asset_version    to anon;
grant select on public.corp_asset_over_time  to anon;
grant select on public.corp_asset            to anon;
