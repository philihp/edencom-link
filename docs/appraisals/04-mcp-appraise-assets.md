# 04 — `appraise_assets`: appraising a place, over MCP

**Status: shipped.** Depends on 01 (the `src/innominate.ts` client), 02 (the
`*_asset_subtree_items()` functions) and 03 (the asset viewer's route, whose
walk this reuses).

## Why

Milestone 1 gave MCP `appraise_items`: a caller states item names and
quantities, and gets prices back. It reads nothing from our DB — it doesn't know
what the user owns. Milestone 2 gave the web UI the other half: an appraise
button that prices a whole ship, container or hangar by walking the asset tree.

That left "what is my Jita hangar worth" answerable in a browser but not over
MCP, where the only path was `browse_assets` → read the stacks back → retype
them into `appraise_items`. That path is lossy (it sees one level, not the
subtree, and `appraise_items` caps at 100 entries against the walk's 500) and
spends more of the shared request budget than the one request the job needs.

## What shipped

A second appraisal tool in `src/app/api/mcp/estateTools.ts` — it belongs with
the estate tools, not with `appraise_items` in `tools.ts`, because it is a
question about what the user *has*:

| Param | |
|---|---|
| `location` (required) | A station/structure/system name substring, or a raw id — the only way to reach one of the caller's own ships or containers. Resolved by the same `matchLocation` helper `browse_assets` uses, which is why `drill_in_with_id` from that tool can be pasted straight in |
| `market` | Hub to price against, default `jita` (same enum as `appraise_items`) |
| `include_items` | Itemize every priced type (up to `MAX_ROWS`) instead of the ten most valuable. Default off |

It returns the batch totals (sell, buy, split, volume), the resolved location and
id, the itemized lines, whatever went unpriced, and the usual `data_refreshed`
stamp — the prices are live, but *what is in the hangar* is only as fresh as the
last assets extract, and that distinction is worth the caller seeing.

## The seam

The walk is not reimplemented. `src/app/api/appraisal/collectAssetLines.ts`
holds it, and both callers use it:

- `POST /api/appraisal` (the viewer's button) — cookie-session client
- `appraise_assets` — bearer-token client

Either way the client is the **caller's own**, never the service role: the
`*_asset_subtree_items()` functions are SECURITY INVOKER and depend on RLS to
scope their walk. A service-role caller would happily walk — and price —
somebody else's hangar.

The pure fold sits in `src/app/api/appraisal/assetLines.ts` (ramda only, no I/O,
unit-tested in `test/assetLines.test.ts`), which is where the three decisions
that would be *quietly* wrong live: blueprints are skipped (an asset row can't
tell an original from a worthless copy), two type ids sharing one SDE name merge
into one line rather than being counted twice, and a type the SDE can't name is
reported as `#<id>` rather than silently dropped from a total that then looks
complete.

`MAX_LINES` (500) is shared from the same module. Past it the tool refuses
rather than truncating, and says to appraise a container instead — the same
reasoning doc 03 gives for the route: a partial total still reads as
authoritative.

## What it deliberately doesn't do

- **Never saves.** `save: true` mints a record on the provider's side and is
  reserved for the viewer's explicit "open this appraisal" arrow — a tool call
  is not a user asking for a stored record. See the README's note on the one
  exception.
- **Sends nothing but names and quantities.** No owner, character, corporation
  or location reaches innomin.at, exactly as for every other appraisal path.
- **Doesn't widen access.** It prices what RLS already shows the caller,
  including corp assets they can see, and nothing else.

`openWorldHint: true`, like `appraise_items` — it is one of only two tools that
leave the deployment.
