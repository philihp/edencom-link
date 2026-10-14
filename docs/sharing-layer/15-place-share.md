# Phase 15 — place shares

**Status:** built in one PR. Migration `20261014161500_asset_place_share.sql`,
SQL test `test/sql/place_share.sql`, pure seam `src/app/asset/placeShare.ts`
(tested).

## The gap

Phases 1–14 share an **item** and everything inside it. A player has no item
to share for "everything I have parked at this station", or a corporation for
"our structures in this system": the station, the structure someone else owns
and the solar system are places, not assets. `/asset/[place]` offered no Share
button, by design.

## The rule

A share's subject id may name a **place** as well as an item. A place share
covers **the grantor's own items whose root sits at that place, and everything
inside them**, live, as the extracts change them.

- The grantor is an account's characters or a corporation. A **character place
  share covers every character-owned item the grantor's account holds at the
  place** (migration `20261014174504`): one `character_asset_share` row, anchored
  on one registration of the account (the one already holding the share, else
  the main), reaching every registration of that account. A corporation's share
  is `corp_asset_share.corporation_id`, as before. Neither covers another
  account's or owner's items at the same place, and a character share never
  covers the account's corporation-owned items.
- The place need not be owned by anyone in particular. Sarah can share her
  items in someone else's Astrahus.
- Nothing new is stored. Both share tables already key on a bare `item_id`, so
  a place share is a row whose `item_id` is a station, structure or system id.
  An item id and a place id cannot collide for one grantor: a character never
  owns a structure or station as an asset. A corporation can own its structure,
  and then sharing the structure's id covers the structure item's tree *and*
  any roots placed at it, which is the same answer.

## The database

Three pieces, one per path a recipient reads through:

1. **`asset_share_covers()`** (the character climb). At a root, which has no
   parent link, the walk steps to the root's place in `character_asset_location`
   (pinned to the grantor), so a share naming that place matches. The place is
   the walk's 16th climb at most, so a place share reaches 15 levels under the
   root. An item share at the root reaches 16, as before.
2. **`corp_shared_item_ids()`** (the corp descent). A second seed: the grantor
   corporation's current roots whose place is a shared subject, entering at
   depth 1 so the reach matches the climb. The function now reads
   `corp_asset_location`, but only to find those roots. It still returns item
   ids, never places.
3. **An audience policy on each place table** (`"Audience reads places a share
   names"`, `"… a corp share names"`). A recipient reads the place of exactly
   the roots a share names, which is the place the grantor chose to name. So
   "the items at this station" is a plain `location_id` filter for them too,
   and `fetchRootItems` works unchanged under RLS. The policy is
   `(owner, location_id) in (uncorrelated subquery)` so the planner makes it
   one hashed subplan per query rather than a probe per row of an owner's own
   read. An item share still hides its root's place.

## The app

- `/asset/[place]` (signed in, not on a share link) offers **one Share button**.
  The dialog chooses between "Your characters' items here" and each corporation
  holding a root there, but only when more than one of those has something: with
  only characters (or only one corporation) holding items, it opens straight on
  that share. Kinds come from the root items' owners filtered to the caller's own
  (`placeGrantors`), so items someone shared *with* the caller never offer one.
  A character share has no show-as-main (several characters can hold items
  there); its signed link opens every character of the account at the place.
  The account-wide expansion for recipients is `shared_place_pairs()`, a third
  argument-free SECURITY DEFINER (`registration` is hidden from them).
- Writers: `savePlaceShare`/`revokePlaceShare` (character, grantor guard =
  one of the caller's registrations) and `saveCorpPlaceShare`/
  `revokeCorpPlaceShare` (corporation, guard = a corp the caller has a
  character in, `created_by` as before). The item writers now share one
  `writeAssetShare`/`writeCorpAssetShare` with them. Revoking a place share is
  scoped to its grantor, since several of an account's owners can each share at
  one place.
- Signed links: `?share=` on a place resolves through the existing walk, whose
  chain now ends at the root's place. Candidate shares are narrowed to the
  requested item's holder, so another owner's place share at the same place
  never resolves for an item it doesn't cover.

## Not done

- GraphQL `sharedWithMe` lists a place share with no item type, since its
  `itemId` names no item. Naming the place there is a follow-up.
- MCP `search_assets`/`list_assets` with `include_shared` join each row to its
  root place under the caller's RLS, so a place-shared row comes back with its
  place filled in, where an item-shared row reads null. That follows from the
  policy above. No test pins it yet.
