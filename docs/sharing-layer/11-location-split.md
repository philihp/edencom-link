# 11 — The location split: sharing an asset never says where it is

## Problem

An asset row's `location_id` does two jobs:

- For an item inside a ship or a container, it names the **parent item**.
- For a **root** item, it names the place the whole tree sits: a station, a
  solar system, or a player structure.

ESI reports a player structure as `location_type = 'item'`, because a
structure is an item too. So `location_type` does not tell a parent from a
place. The rule every walk in `schema.sql` already uses is this: an asset's
root is the first `location_id` that is not another asset of the same owner.
The ESI OpenAPI document lists `location_type` as `station`, `solar_system`,
`item` or `other`, and says nothing more.

Phase 2 ([02-recursive-rls.md](02-recursive-rls.md)) lets a share's audience
read the shared item and everything nested in it. The policy returns whole
rows. So the shared item's own row gave its station or structure to every
recipient. For a public share, it gave it to anyone with the public anon key.
The place then showed through the ship page breadcrumb, `/asset/search`, the
location summary functions, GraphQL `assets(includeShared)`, the MCP tools, and
station-id probes of `*_location_contents` and `*_subtree_items`. Signed
`?share=` links were safe, because they go through the service-role loader
(`sharedShip.ts`), which never reads a location.

## Design

Migration `20260926054546_asset_location_split.sql`:

| Object | What it is |
| --- | --- |
| `character_asset_version` | The table, renamed from `character_asset_over_time`. Its location columns hold only a parent that is another asset of the same owner. For a root item they are null. |
| `character_asset_location` | The root item's place (`location_id`, `location_type`, `location_flag`), 1:1 with the version row (`asset_id`), so it has the same SCD-2 history. RLS: **owner only**. `anon` has the grant but no policy, so it reads no rows. |
| `character_asset_over_time` (view) | Security-invoker `UNION ALL` of parent rows and root rows joined to their place. Same columns, same order as the old table. |
| `character_asset` (view) | The current rows of the view above, as before. |

The owner sees exactly what they saw before. A recipient sees the shared item
and everything in it, with the item's place as null. They can still drill from
a shared container into a ship and into the ship's containers, because those
links are parent links on the version table.

The location table is where a later "share the location too" feature goes: it
has its own sharing layer, with its own rules, and today that layer is owner
only.

### What reads what

- **Readers:** every page, job, function and GraphQL resolver that reads
  `character_asset_over_time` or `character_asset` keeps working unchanged.
  The service role sees the place (no RLS). The owner sees it through the
  owner policy. A recipient sees null.
- **Writes** go to the table:
  - The extract's `valid_until` and `is_current` updates now target
    `character_asset_version`.
  - `character_asset_claim()` inserts the version rows, then moves each root
    item's place into the location table. A location is a parent when it is
    the item id of an open row of the same owner, counting the rows inserted
    in the same call.
- **Walks** join the version table directly. These are the recursive steps of
  `*_location_contents`, `*_subtree_items`, `*_search`, `*_filter` and
  `asset_ancestors`, plus the parent lookups in search and filter. The view is
  a `UNION ALL` with a join inside, and the planner cannot push a join
  condition into it, so a walk through the view scanned the whole table at
  every step: 7 ms → 760 ms for one station's contents at 180k rows. A child
  never names its parent through the location table, so the version table is
  exact. Only the seeds ("what is at this place") read the view, and that is
  also what keeps a recipient's walk from starting at a station.
  `asset_ancestors` looks up the root's place once, at the end.
- **`asset_share_covers()`** climbs the version table. It only ever needed
  parent links.
- **Relink.** The extract claims 1000 rows a call, in ESI's order, so a
  container's contents can arrive a call before the container (or a run
  before it). The child then has no open parent row, and its parent's id is
  filed as its place. The parent's claim moves it back: any current place row
  of the same owner whose `location_id` is one of the items just inserted
  becomes a parent link again. Without this the share walk could not climb
  through that child, and a recipient would not see it.
- **The one assumption** in both the backfill and the claim: a place id never
  equals an item id of the same owner. Station ids (60M), system ids (30M) and
  structure ids (1e12+) sit outside the item ids a character owns, so a place
  is never mistaken for a parent link — which is the direction that would
  leak. The other direction (a parent link mistaken for a place, when the
  parent row is missing) costs a recipient that child's visibility, and the
  relink repairs it once the parent lands.
- **Names.** The table predates the migrations folder and was renamed once
  before, and a table rename never renames constraints or the identity
  sequence, so the migration discovers the primary key, the foreign key and
  the sequence from the catalogs before renaming them.

### Measured (owner, 180k assets, local Postgres 16)

| Query | Before | After |
| --- | --- | --- |
| The migration itself (backfill included) | — | 0.35 s |
| Children of a ship (`location_id = ship`) | 2 ms | 3.5 ms |
| Items at a station | 0.6 ms | 2 ms |
| `character_asset_location_contents(station)` | 7 ms | 8 ms |
| `asset_ancestors` (breadcrumb) | ~600 ms | **2 ms** |
| `character_asset_search` | ~1.1 s | ~1.55 s |
| `character_asset_location_summary()` (live) | 1.4–1.9 s | ~2.0 s |

The breadcrumb got ~300× faster because its recursive hop became an index
probe (see `asset_ancestors` above); before, every hop scanned the table
under RLS. The two slow rows were already seq scans before the split: the
audience policy's `OR` defeats the registration index. `/asset` reads the
summary cache, not the live function.

### Safety: no value is deleted, and the migration proves it

The only destructive-looking statement is the `update` that nulls a version
row's place — and it runs after the `insert` that copied that place, in the
same transaction (`supabase db push` applies each file in one). So a place
is moved, never dropped. The migration then checks that claim rather than
trusting it: before anything moves it takes a fingerprint of every row's
location data (row count, placed count, and a sum of per-row hashes, so it
costs no memory at scale); after the views exist it takes the same
fingerprint through `character_asset_over_time`, and raises if any of the
three differ. A raise rolls the whole file back with the table untouched. It
also raises if any version row still carries a place after the move.

**Rollback.** `docs/sharing-layer/rollback-location-split.sql` (not a
migration; run by hand, `psql --single-transaction`) moves every place back
onto its version row — including versions the new claim wrote after the
split — checks the same fingerprint, drops the views and the place table,
renames the table back, recreates the plain `character_asset` view and
restores the eight functions to their pre-split bodies. Proven by
`test/sql/asset_location_split_rollback.sql` (old shape → migration →
rollback: every row identical, `except` both ways empty) and by a round trip
on 4,006 synthetic rows where a full `pg_dump` of the table was
byte-identical afterwards. The one thing it leaves is the
`character_asset_share.show_as_main` column, which the old code never reads.

**Before merging**, take your own copy of the two tables the migration
touches; it is the fastest way back if anything else goes wrong:

```
pg_dump "$DATABASE_URL" --data-only -t public.character_asset_over_time -t public.character_asset_share \
  | gzip > asset-tables-before-split.sql.gz
```

And confirm the one assumption on real data (must print 0):

```sql
select count(*) from public.character_asset_over_time where item_id between 30000000 and 64999999;
```

**After the Migrate workflow runs**, these should hold:

```sql
-- every version row has either a parent link or a place row, never both
select count(*) from public.character_asset_version v
  join public.character_asset_location l on l.asset_id = v.id where v.location_id is not null;   -- 0
-- the owner-only table holds one row per root version
select count(*) from public.character_asset_location;                                             -- > 0
-- anon reads no place (run as the anon key through PostgREST: GET /rest/v1/character_asset_location → [])
```

### Known gaps

- A recipient's `/asset/search` and MCP `list_assets` do not list a shared
  item: those functions join each item to its root, and a shared item has no
  root for the recipient. Restoring it is a `left join roots` plus null
  handling in the pages.
- A shared container nested inside an unshared ship shows the ship's item id
  as its parent link. The id resolves to nothing for the recipient, so it
  says only "inside another of the owner's items".
- The old-code / new-code window at deploy: the migration and the Vercel
  deploy start together on merge, so one `character-assets` run can fail its
  writes (old code updating what is now a view, or new code before the
  rename). The reconcile is idempotent and the next run recovers.
- The jobs that page the whole current asset set through the view
  (`universe-structures`, `resolveAssetStationNames`, `resolveAssetSystemNames`)
  pay a sort of the union per page: ~65 ms a page against ~1 ms, so ~8 s a
  day for 117k rows. Pointing them at `character_asset_location` directly
  would remove it; not done here.

## Owner shown as the main character

`character_asset_share.show_as_main` shows the grantor account's main
character as the owner, in place of the alt that holds the item. The share
dialog offers it when the item's holder is not the account's main.
`mainOwnerOf()` (service role, reached only after the share is verified)
supplies the main's name and portrait, in three places:

- `sharedShip.ts`: the signed-link page and the Discord card
- `fetchShipOwner`: signed-in recipients, using share rows their own RLS lets
  them read

This is **presentation only**. The asset rows still carry the holder's
`registration_id`, and the world-readable `character_directory` resolves it to
the holder's name. So a recipient reading the data API can still find the alt.
Closing that means changing `character_directory`'s grants and the
fitting-share predicate that depends on them. That is a separate change.

## Tests

`test/sql/asset_location_split.sql` covers the backfill, the owner and
recipient views, `anon`, the station probes, the claim (moves, a container in
space, a child arriving with its container), and the share walk through the
split.
