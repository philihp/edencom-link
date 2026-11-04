# Nested asset filters: location and hangar look through containers

**Status: ✅ done.** `character_asset_within()` / `corp_asset_within()`
(migration `20261104180611_asset_within.sql`) do the walk. The GraphQL `assets`
and `restock` lists call them through the pure seam
`src/app/api/graphql/assetWithin.ts`. Tests: `test/sql/asset_within.sql` and
`test/graphqlAssetWithin.test.ts`.

## The problem

A player asked Aura for one Data Link: every asset of their corporation in
HFC-AQ, in corporation hangars 3 and 4, including what is inside the containers
in those hangars. Aura could not write it.

The `location`/`locations` and `includeHangar`/`excludeHangar` filters compared
the `location_id` and `location_flag` of each row only. These columns describe
the nearest holder of the row:

| Row                          | `location_id`     | `location_flag` |
| ---------------------------- | ----------------- | --------------- |
| Office                       | the structure     | `OfficeFolder`  |
| Container in hangar 3        | the Office        | `CorpSAG3`      |
| Tritanium in that container  | the container     | `Unlocked`      |
| Tritanium loose in hangar 4  | the Office        | `CorpSAG4`      |

Thus:

- `includeHangars: ["CorpSAG3", "CorpSAG4"]` lost the tritanium in the
  container.
- `location: "HFC-AQ"` matched the Office only. The items in the hangars sit in
  the Office, not in the structure.
- A list of container ids worked for one day only. A new container, or a
  container moved between hangars, made the list wrong.

## The rule

On `assets` and `restock`, the location and hangar filters follow the parent
chain of each item.

- **Location.** An item matches when it sits in one of the places, or anywhere
  inside a container, ship or Office that sits there. A solar system names
  every NPC station and player structure in it (from `sde_station`,
  `corp_structure` and `universe_structure`), and what floats in space there.
  The item id of a container or ship names its contents, at any depth, but not
  the container itself.
- **Include hangar.** An item matches when its own flag, or the flag of a
  container above it, is in the list.
- **Exclude hangar.** An item is dropped when its own flag, or the flag of a
  container above it, is in the list. A stack with no flag stays.

Each row still reports its own `locationId` and `locationFlag`.

The filters are read when the query runs. Nothing is stored. A new container is
in the result after the next assets extract. A container that moves out of the
hangar takes its contents out with it.

The MCP `list_assets` location filter already used containment
(`character_asset_filter()`). The "Container contents" link template already
promised it. Now GraphQL does the same.

### Include and exclude together

`resolveHangarFilters` (`hangarFlags.ts`) still removes from the include list a
flag that both lists name. It now keeps an exclusion that the include list does
not name. With the nested rule, `includeHangar: "CorpSAG3", excludeHangar:
"Cargo"` is a useful filter: the ships in hangar 3 stay, and their cargo goes.
Before, this exclusion had no effect, and the code dropped it.

### Blueprints are not changed

`blueprints` still reads the flag of each blueprint row only. A blueprint in a
container has the flag of the container compartment. The schema description says
this. To look through containers, use `assets` with a type filter.

## How the walk works

Each function takes the owner list (registration uuids or corporation ids), the
type ids, the location ids, the include flags, the exclude flags and a row
limit. It returns one json object: `{"total": n, "rows": [...]}`. The total
counts every match. The rows are at most `row_limit` (clamped to 50 000), in
`item_id` order. One call does the walk once. A PostgREST page loop would do the
walk once for each page, and a 50 000-row link export has 50 pages.

1. **Seeds.** Each filter starts from the rows that it names directly: a root
   whose place or flag (in `*_asset_location`) matches, or another row whose
   parent or flag matches. A non-root row counts only when its parent has a
   current row that the caller can see. These are the rules of the
   `character_asset`/`corp_asset` views.
2. **Descent.** From each seed, the walk goes down through current child rows
   (`*_asset_version_current_location_idx`), to depth 64.
3. **Result.** The location set and the include set intersect. The rows come
   from the version table, with the root place from the location table, as the
   view shows them. The exclude set is subtracted. An exclusion with nothing
   included reads all the rows of the owners through the view.

### Security

- **The owner list is the leak guard.** A Data Link runs on the service-role
  client, so RLS does not apply. Every seed and every result row is filtered by
  the owner list. A child row always has the owner of its parent.
- **Session mode.** The functions are `SECURITY INVOKER`, so RLS applies too. A
  share recipient cannot see the place of a shared root, or a parent link out
  of the shared tree. A location filter thus finds a shared item only through a
  container inside the shared tree.

### Performance

Two traps, both measured on a generated hangar of 76 000 rows:

- **`IN` inside `OR`.** `(no filter) OR item_id IN (walk)` cannot become a
  join. Postgres ran it as a subplan that scanned the walk again for each row:
  30 s. The sets are now left-joined.
- **JIT.** The planner cannot estimate a recursive walk. It guessed 70 million
  rows, so the plan cost went above `jit_above_cost`, and Postgres spent about
  1 s to compile a plan that ran in 0.12 s. The functions set `jit = off`.

After both fixes, the 76 000-row hangar takes 120–460 ms on the service role and
250–340 ms under RLS. The `authenticated` role has a statement timeout of 8 s.

A query with no location or hangar filter does not use the walk. It reads the
views directly, as before.
