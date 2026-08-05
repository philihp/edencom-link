# Phase 2: recursive RLS — the widening policy on assets

**Status: ✅ done** — migration `20260805010000_asset_share_recursive_rls.sql`.
Implementation note vs the sketch below: `asset_share_covers()` gained a
second parameter, the row's `registration_id`, so the share scan filters to
shares by that grantor — rows of unshared hangars short-circuit on one
indexed probe (a share can only cover its grantor's own items). The walk uses
a per-step best-known-parent lateral probe instead of materializing
`parent_of` for the whole table, and is gated on any matching share existing.
Covered by `test/sql/asset_share.sql`, including a policy-level smoke as the
`authenticated` role proving no policy recursion.

The hard phase. A share on a ship or container must open **everything inside
it**, to any depth, purely through RLS — so `/asset/[locationId]`,
`/ship/[itemId]`, the MCP tools, and GraphQL all inherit shared visibility by
querying as the caller, with no parallel service-role path.

## The recursion problem, stated plainly

The natural policy is "this asset row is visible if it, or any ancestor
container, is the subject of a share matching the caller":

```sql
create policy "Audience reads shared assets"
  on public.character_asset_over_time
  for select
  to anon, authenticated
  using (is_current and public.asset_share_covers(item_id));
```

`asset_share_covers()` must climb the parentage chain — and parentage lives
in `character_asset_over_time` itself. An invoker-rights helper selecting
from the table it is a policy on re-enters that policy, and Postgres aborts
with `infinite recursion detected in policy for relation
"character_asset_over_time"`. This is the unresolved warning design.md Stage
E flagged; this phase resolves it.

## The one sanctioned SECURITY DEFINER

`asset_share_covers()` is written `security definer` with a pinned
`search_path`, as **the single exception** to the no-definer invariant. The
exception is safe because the function:

- returns a single boolean — it can never leak row data;
- reads only parentage columns (`item_id`, `location_id`) plus the share
  table, and matches audiences through `asset_share_matches_caller()`, whose
  `my_*_ids()` calls still resolve `auth.uid()` to the _caller_ inside a
  definer context — so it grants exactly what the audience rules say;
- is `revoke`d from `public` and granted only to `anon, authenticated`.

```sql
create or replace function public.asset_share_covers(item bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    -- Best-known parent per item, the same distinct-on shape
    -- character_asset_location_summary() uses (bridges snapshot gaps).
    parent_of as (
      select distinct on (item_id) item_id, location_id
      from character_asset_over_time
      order by item_id, is_current desc, valid_until desc
    ),
    walk (node, depth) as (
      select item, 0
      union all
      select p.location_id, w.depth + 1
      from walk w
      join parent_of p on p.item_id = w.node
      where w.depth < 16
    )
  select exists (
    select 1
    from character_asset_share s
    join walk w on w.node = s.item_id
    where asset_share_matches_caller(s.corporation_ids, s.alliance_ids, s.secret)
  );
$$;

revoke execute on function public.asset_share_covers(bigint) from public;
grant execute on function public.asset_share_covers(bigint) to anon, authenticated;
```

Depth cap 16 matches `asset_ancestors()`. `is_current` on the policy (not in
the helper) keeps SCD-2 history closed: a share opens the **current view
only** — the same rows `character_asset` shows the owner.

## Performance

The policy runs per candidate row, and the naive form climbs per row.
Mitigations, in order of importance:

1. **Fast-path guard**: `character_asset_share` is small; when the caller
   matches no share row at all (the overwhelmingly common case), the helper
   must exit without recursing. Structure the SQL so the planner can start
   from the share table: first collect the caller-matching share subjects,
   return false immediately if none, and only then walk — climbing _down_
   from the handful of shared roots (the seeded-recursion shape
   `character_asset_search()` uses) beats climbing _up_ from every candidate
   row. Equivalent semantics, opposite direction; benchmark both under
   `explain analyze` and keep the winner.
2. Index `character_asset_share (item_id)` (phase 1) and rely on the existing
   `character_asset_over_time` item/parent indexes.
3. The policy is OR'd with the owner policy (permissive policies compose with
   OR), so the owner's own queries are unaffected when the share check is
   slow — but grantee page loads are the experience to protect.

`pnpm run test:sql` gets a `blueprint_search`-style script asserting: nested
item visible through a shared grandparent container; sibling container not
visible; revoked share closes access; depth cap respected.

## Grantee access to the walk RPCs

`character_asset_location_contents(parent)` /
`character_asset_subtree_items(parent)` / `asset_ancestors(start_id)` are
SECURITY INVOKER — once the widening policy exists they **just work** for
grantees over the shared subtree, because the underlying selects now return
the shared rows. Verify this rather than assuming it: the
`/asset/[locationId]` contents counts and the appraisal fold
(`collectAssetLines.ts`) are the acceptance tests. `asset_ancestors` on a
shared item ends its climb at the shared root's parent (a row the caller
can't see just stops the walk) — the breadcrumb for a grantee shows the path
_within_ the share, which is the right disclosure.

Corp-owned assets (`corp_asset_over_time`) are **out of scope** for this
phase: shares are granted by a registration over character assets. A
`corp_asset_share` mirror can follow the same recipe later if wanted; note it
in Non-goals rather than half-building it.

## Deliverables

- Migration + `schema.sql` (dual-write): the policy, `asset_share_covers()`,
  grants.
- `test/sql/asset_share.sql` for `pnpm run test:sql`.
- No app-code changes — that's the point.

## Verification

Two-account test: B sees a container A shared (and its nested contents, via
`/asset/[id]` opened as B), and nothing else from A's hangar; anon sees a
fully-public share without signing in; revoke closes it. `explain analyze` on
a grantee's `character_asset` select over a large hangar stays interactive.
