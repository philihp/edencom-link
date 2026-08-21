# 05 — Appraise a selection, not a column

**Shipped.** Replaces the per-row appraise column doc 03 built with row
selection plus one appraisal control per table. Issue #809.

## Why

Doc 03 put an appraise button on every row. Three things were wrong with that
in use:

- **It multiplied requests against a budget that can't take them.** The
  provider allows 200 calls an hour for the whole deployment. A column of
  buttons invites a click per row, and the global throttle's drain rate had
  already been raised from 18s to 2s (see the README) specifically to stop a
  handful of those clicks from queueing for over a minute. The right shape is
  one request per _question the user is asking_, and the question is usually
  "what is this lot worth", not "what is row 14 worth".
- **The answers had nowhere to go.** Each cell held a total that only meant
  something on its own; adding two rows up meant reading two cells.
- **On a ship page the list left out the ship.** The hull is the container of
  everything in the table, so it was never one of the child rows — and the
  table that reads as "what's on this ship" quietly wasn't.

## What it is now

**Selection.** `LocationAssets` gains a leading checkbox column (owner's view
only — the anonymous share path has no session to appraise with, so it gets
neither checkboxes nor a footer). The checkbox's hitbox is a `<label>` padded
10px past the box and pulled back by the same margin, so the target is generous
without the rows getting taller.

Dragging over the rows draws a dashed rectangle and selects what it touches:
plain drag **replaces** the selection, shift-drag **adds** to it. Touching a row
counts — requiring containment would be unusable on rows that are wide and
short. The pointer is tracked on `window`, not the table, because a sweep
routinely leaves the element and the mouseup can land anywhere. A drag under 5px
is a click that wobbled and does nothing, so clicking the table never silently
clears a selection.

The geometry is pure and lives in `selectionMarquee.ts` (`boxBetween`,
`isDrag`, `intersects`, `applyMarquee`), unit-tested in
`test/selectionMarquee.test.ts`; the component keeps only "where did the pointer
go". Row rectangles are read from the DOM at hit-test time via
`tr[data-item-id]` — layout is the only thing that knows where a row currently
is.

Selection means the rows currently _on screen_: the owner filter can hide a
checked row, and the footer prices only what's visible (the hidden ids stay in
state, so unhiding restores them).

**One control instead of a column.** `AppraisalPanel`
(`src/app/asset/[locationId]/appraisalPanel.tsx`) replaces `AppraiseButton`,
which is deleted along with its stylesheet. It renders a secondary button; on
click, the high (sell) and low (buy) totals, **stacked one per line** in the
tabular face so their digits line up, with the exact figures / line count /
skips still on the hover title. Beside them is a primary `↗` button that re-runs
the batch with `save: true` and — this is the change from doc 03 — **replaces
itself with a plain link** to the saved appraisal, rather than popping a tab
open itself. The old flow opened `about:blank` synchronously inside the click to
dodge pop-up blocking; a link the user can middle-click, copy or open where they
like is both simpler and better behaved.

Changing the selection resets the panel: a price quoted for one set of rows is
not true of another, and leaving the old figure on screen would be a lie.

Three call sites, all the same component:

| Where                               | Targets                                          |
| ----------------------------------- | ------------------------------------------------ |
| Under the asset table, bottom right | the selected rows                                |
| `/asset/[locationId]` header        | the location itself ("Appraise everything here") |
| `/ship/[itemId]` header, top right  | the ship item id ("Appraise ship")               |

**The hull is a row.** `/ship/[itemId]` prepends a row for the ship itself to
the table (both the signed-in and the share-link views), so "everything shown in
this list" is what the header button prices. It's a singleton with no stack
size, links nowhere (this is already its page), and its Contents cell counts the
whole subtree. The fit viewer above still receives the children alone — a ship
isn't a module fitted to itself.

## Server

`POST /api/appraisal` now takes `{ "targets": ["<id>", …] }` as well as the
original `{ "target": "<id>" }`; both land in one list, capped at `MAX_LINES`
(500), each still `/^\d+$/`. Still exactly **one** upstream call.

The fan-out had to collapse on our side too, or a 40-row selection would be 80
round trips to Postgres. `collectAssetLinesForTargets` is four queries whatever
the selection size: two `in ('item_id', targets)` self lookups and two walks,
over new **array-taking overloads** of `character_asset_subtree_items` /
`corp_asset_subtree_items`
(`supabase/migrations/20260806150000_asset_subtree_items_many.sql`, mirrored into
`schema.sql`). The scalar overloads stay — the MCP `appraise_assets` tool and
the two header buttons still ask about one place, and `collectAssetLines`
remains as the one-target wrapper.

Two cases the scalar walk never had to think about, both of which a selection
can genuinely contain (a container and something inside it):

- an item reached by two parents' descents is folded once (`distinct on
(item_id)`), not counted twice;
- an item that is itself one of the parents is dropped by the walk, because the
  caller adds a line for every target it resolved — otherwise the nested target
  would be priced both as a target and as its parent's content.

So targets need not be disjoint, and nothing is priced twice.

## Verification

`pnpm run lint`, `pnpm run build`, `pnpm test` (the marquee geometry),
`node .github/scripts/check-migrations.mjs`. By hand, signed in: sweep a box
over some rows and check the count in the button; shift-sweep a second group and
check it adds; tick a row's checkbox near the edge of the cell; appraise the
selection and confirm the total moves when the selection does; press `↗` and
confirm the link resolves to the saved appraisal on innomin.at; open a ship page
and confirm the hull heads the table and "Appraise ship" exceeds the hull's own
price; open a `?share=` link and confirm there are no checkboxes, no footer and
no appraise button.
