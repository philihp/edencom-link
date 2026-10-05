# Phase 4 — Assets: "do I have X, and where"

## Goal

Two screens over the existing `assets` query. **Search**: type an item name,
get every stack across every character and corporation, grouped by place with
totals. **Browse**: pick a place (station, structure, system) and see what is
there, then drill into a container or a ship. This is `/asset/search` and
`/asset/[locationId]` on a phone, with the MCP `search_assets` tool's answer
shape as the model for the search result.

## What the schema already gives

`assets(type, types, location, locations, includeHangar…, owner…, limit)`
returns `AssetPage` rows with owner, type, quantity, place and hangar flag.
That is enough for both screens. Two gaps to fill server side, both small:

1. **Type-name autocomplete.** The web uses `GET /api/type/search`. Add a
   GraphQL field `typeSearch(query: String!, limit: Int): [TypeHit!]!` over
   `searchSdeTypes` (`src/sdeTypes.ts`) so the app has one API. Public SDE
   data, so it needs no auth beyond the bearer the client already sends.
2. **Place list.** "Browse" needs the set of places the user holds assets at,
   with counts — what `character_asset_location_summary()` /
   `corp_asset_location_summary()` return for the web's `/asset` page. Add
   `assetPlaces: [AssetPlace!]!` (place id, kind, name, system, stack count,
   owner kinds present) over those two RPCs, scoped the same way the web page
   scopes them.

Both fields read tables and RPCs that exist. No migration.

## Files

- `mobile/app/(tabs)/assets.tsx` — search box with autocomplete, results
  grouped by place.
- `mobile/app/assets/place/[id].tsx` — browse one place; a row that is a
  container or a ship with contents opens `[id]` again (the `assets` query
  with `location: <item id>` already walks into a container).
- `mobile/src/screens/assets/groupByPlace.ts` — pure: rows → places → totals,
  sorted by system then place then type, as `search_assets` does. Tested.
- `mobile/src/ui/TypeIcon.tsx` + `mobile/src/ui/iconVariation.ts` — the
  seed-then-verify rule from `src/app/iconVariation.ts` (shared or copied per
  phase 0) and a cache of `GET https://images.evetech.net/types/{id}` answers.
  The web keeps that cache in `localStorage` because it must be synchronous
  for the server render; the app has no server render, so an async store
  (`expo-sqlite/kv-store`) read in a hook is fine. Keep the invariant: **never
  ask the image server for a variation the type does not have** (a 400, not a
  fallback). Preload the cache for the visible rows' type ids before painting.

## Steps

1. Server PR: `typeSearch` and `assetPlaces`, tests for their pure shaping,
   `link_schema` checked.
2. Search screen with text-only results; then icons; then grouping.
3. Browse screen; drill-down; a ship row links to the (phase 5 or later) ship
   screen, or to the website's `/ship/[id]` in the system browser until then.

## Done when

- "myko" finds every Mykoserocin stack the MCP `search_assets` tool finds for
  the same account, with the same totals. Compare on a real account and paste
  both in the PR.
- Browsing a station lists the same rows as `/asset/<stationId>` on the web.
- No image request in the simulator's network log returns 400.

## Risks and notes

- **Blueprints.** The web's search excludes them unless asked
  (`include_blueprints`). Do the same: a toggle, default off; blueprint icons
  use the `bp`/`bpc` variation from the category rule.
- **Large hangars.** `assets` caps rows (`ASSET_CAP`). Show "showing N of M"
  when the page is capped; do not page in v1.
- **Shared rows.** `includeShared` stays `false` (README constraint 7).
