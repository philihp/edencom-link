# Phase 17 — one share model for every subject

**Status:** built, page-only (`subjectGrantors` in `src/app/asset/placeShare.ts`,
tested; `/asset/[locationId]/page.tsx`). Fixes `/asset/1050530810113` (a
corp-owned Tatara full of one account's reaction materials) offering only the
corporation's share.

## What the user is looking at

Every asset page is a **subject that contains things**: a solar system, a
station or structure, a container, or a ship. A ship can hold a ship or a
container; a container can hold a ship; a structure never holds a structure.
From the user's side there is no "item page" and "place page" — there is a
thing, and what is in it, and the question "who can I share what is in here
*as*?"

The answer is: **as each owner of theirs that holds something here.** An
account's characters, or any corporation the caller has a character in. At a
system or station that is the roots sitting there. At a container or ship it
is the one owner of the container, since what is inside belongs to whoever
owns it. At a **structure it is both at once**: the owning corporation holds
the structure itself (its fittings, fuel, office tree), and other owners park
their items *in* it as roots.

## Where the page goes wrong

`/asset/[locationId]` first asks whether the id is one of the caller's own
items (`fetchSelf`). If it is, the page offers that item's single-owner share;
if it is not, it offers the place share with a chooser over every owner holding
a root there (`placeGrantors`). A structure the caller's corporation owns
answers *yes* to the first question, and the place branch — the one that would
have offered "your characters' items here" — is skipped outright.

So the bug is not in the database and not in the dialog. Phase 15 already
settled that for a corporation owning its structure, the structure's item share
and its place share are **the same row** (`corp_asset_share (corporation_id,
item_id)`), covering the structure's tree *and* the corp's roots placed at it.
It is only the page's either/or that is wrong.

## The rule

The grantors a subject offers are the **union** of

1. the owner of the subject, when the subject is an item the caller holds (one
   character of the account → a character share; a corporation → a corp
   share), and
2. every owner of the caller's holding a **root** at the subject — the
   account's characters as one grantor, each corporation as its own —

deduplicated by grantor, since a corporation that owns a structure and has
roots at it is one grantor on one row. Offer **one Share button**; the dialog
asks which grantor only when there is more than one, as `PlaceShareDialog`
does today.

| subject                    | grantors offered                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| system, station            | characters (if any roots) + each corp with roots                                             |
| structure someone else owns| the same                                                                                     |
| structure our corp owns    | **that corp** (the structure and everything it holds there) + characters + other corps' roots |
| container, ship            | its one owner (contents are theirs); never a chooser                                         |

A character-owned item (a ship, a can) never has roots *at* it from another
owner — an item's place is a station/structure/system, never a ship — so rule 2
adds nothing there and the single-owner page stays exactly as it is. The only
subject where both rules fire is a corp-owned structure. The change is to stop
treating `self != null` as "therefore not a place".

## What each grantor's share means

The hint line (`shareHint`) already names the owner. For a structure the two
options need to say which half they are:

- **Your characters' items here** — everything the account's characters have
  parked in this structure, live. `character_asset_share` row on
  `item_id = structure`, anchored as phase 15 anchors a place share.
- **\<Corp\>'s items here** — the structure itself, its fittings and fuel, its
  office and hangars, and anything else the corp has placed here.
  `corp_asset_share (corp, structure)` — the row phase 15 already covers both
  halves with. Made on behalf of the saving member; disabled when that
  character leaves the corp.

Neither reaches the other's items. A recipient of the corp share does not see
Sir Cuddles' reagents; a recipient of the character share does not see the
fuel bay.

## Who may make the corp share

Today any member of a corporation may share its hangar (phase 14: "whoever can
read the corp hangar can share it"); there is no director gate on
`corp_asset_share`. That is unchanged here. If a director-only rule is wanted
for structures, it is a separate decision — the structure *details* share
(phase 12, `corp_structure_share`) is already director-only, and the two could
be aligned — but it is not what breaks the Tatara page.

## The app change

All in `/asset/[locationId]/page.tsx`; nothing in SQL.

- Compute the grantor list for **every** signed-in, non-share-link view:
  `placeGrantors(rootItems, owners)` as now, plus the subject's own owner when
  `self` is set (a character grantor if `isOwnCharacterItem`, else the corp
  grantor for `self.corporation_id`), deduplicated on `grantorKey`.
- Fetch one dialog payload per grantor, as the place branch does; the corp
  one through `fetchCorpShareDialogData` when the subject is the corp's own
  item (it checks membership through the item) and `fetchCorpPlaceShareDialogData`
  otherwise — both land on the same row, so either answer is right.
- Render `PlaceShareDialog` whenever there is more than one grantor; keep
  `AssetShareDialog` for the one-grantor item case so the ship page and
  container page are untouched. The hint for a corp grantor on its own
  structure says "the structure and everything it holds", not only "items in".
- `placeGrantors` grows a seam for the self owner, so the union is testable in
  `test/placeShare.test.ts` without a page.

Not touched: `/ship/[itemId]` (one owner by construction), the share writers,
the signed-link resolver, RLS.
