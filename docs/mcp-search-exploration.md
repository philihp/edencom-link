# MCP search & exploration endpoints (plan)

> **Status:** PR 1 (DB views) shipped. The **planet slice** of PRs 2–3 shipped
> next, out of the table's order, because the ask that motivated it was narrow
> — "how do I turn 40099763 into Q-UVY6 II through MCP?", which nothing
> answered. That delivered `getSystemPlanets`/`getRegionPlanets` in
> `src/sdePlanets.ts`, the new `src/sdeRegions.ts`, and `exploreTools.ts` with
> `list_planets` (which also took `planet_ids` — an id-resolver mode this plan
> didn't have, since a raw den `planet_id` was the original ask). Still open:
> `sdeGroups.ts`, the type-taxonomy tools (`get_type`, `list_item_groups`,
> `list_types`), `explore_region`, the blueprint tools' `type_id` params, and
> all of PR 4.
>
> Two decisions worth carrying forward, both settled while building the planet
> slice: `escapeLike` now lives in `src/utils/escapeLike.ts` (a loader must not
> import from the MCP layer; `structureQuery.ts` re-exports it), and the
> "`fetchAllRows` home" open question below resolved as **neither** — the
> loader pages tail-recursively per CLAUDE.md's pagination pattern, which
> `fetchAllRows`'s `for` loop predates.

Add static-game-data exploration to the MCP server, and let asset search cut by
item taxonomy instead of only by name. Four user-facing additions:

1. **Search assets by category or group** — "show me all my ships", "how many
   drones do I have in EKPB-3" — without naming a specific type.
2. **Type-taxonomy exploration** — browse categories → groups → types, list
   every typeID in a group or category, and look up blueprints by `type_id`
   directly (today the blueprint tools only take fuzzy names).
3. **Universe exploration** — every constellation and system in a region, with
   security status.
4. **Planet composition** — the planet-type breakdown of a system, and
   region-wide "which systems have temperate planets" (mercenary dens) /
   "which have lava planets" (PI) queries.

Everything reads the nightly-mirrored `sde_*` tables (plus the existing
RLS-scoped asset RPCs for #1). No ESI calls, no new extract jobs.

## What already exists

| Piece                                                                                         | Where                                                          | What it gives us                                                                                                      |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sde_published_type` view                                                                     | `20260716010000_sde_mirror.sql`                                | `type_id, name, group_id, category_id` for every published type                                                       |
| `sde_search_type` / `sde_search_system` RPCs                                                  | same                                                           | coverage-ranked ILIKE search, the pattern to mirror                                                                   |
| `sde_kspace_system` view                                                                      | extended in `20260719120000_sde_kspace_system_region_path.sql` | systems **already carry** `constellation_id/_name` and `region_id/_name` — the region→systems query needs no new join |
| `sde_planet` view                                                                             | `20260716010000_sde_mirror.sql`                                | `planet_id, system_id, celestial_index, type_id, system_name` for every planet                                        |
| Raw mirror tables `sde_groups`, `sde_categories`, `sde_map_regions`, `sde_map_constellations` | minted by the nightly ingest (every JSONL file lands)          | group/category/region names sit in `data -> 'name' ->> 'en'`, just not yet projected as app-shaped views              |
| `sde_blueprint_product` matview + `src/sdeBlueprints.ts`                                      | SDE cutover PR 4                                               | `getBlueprintForProduct` / `getBlueprintsForMaterial` already keyed by typeID — the MCP tools just don't accept one   |
| MCP plumbing                                                                                  | `src/app/api/mcp/lib.ts` / `tools.ts`                          | `textResult`, `resolveTypeFilter` (`MAX_TYPES = 100` guard), `MAX_ROWS = 200` display cap, `fetchAllRows` paging      |
| `TEMPERATE_PLANET_TYPE_ID = 11`                                                               | `src/sdePlanets.ts`                                            | precedent for planet-type reasoning; `/mercenary-dens` is the existing consumer                                       |

So the bulk of the work is: three small views + two view extensions (one
migration), three loader modules' worth of functions, and one new MCP tool
file. No new mirror ingest, no RPCs unless a rollup turns out too heavy
client-side (see Open questions).

## Database work (PR 1: one migration + `schema.sql`)

One migration (e.g. `sde_taxonomy_views`), all additive. Every object follows
the mirror's access model: `security_invoker` views over the RLS-enabled
mirror tables, `SELECT` granted to `anon, authenticated, service_role`, writes
revoked. `schema.sql` gets the same objects appended to its SDE mirror section
**and** the new view names added to the drop list at the top (the sweep is by
name for views, by `sde_%` prefix only for tables).

New views:

```sql
-- Groups with their category, published flag kept so the taxonomy browser can
-- default to published-only without losing the ability to show everything.
create view public.sde_group with (security_invoker = true) as
select
  g._key as group_id,
  g.data -> 'name' ->> 'en' as name,
  (g.data ->> 'categoryID')::bigint as category_id,
  c.data -> 'name' ->> 'en' as category_name,
  (g.data ->> 'published')::boolean as published
from public.sde_groups g
left join public.sde_categories c on c._key = (g.data ->> 'categoryID')::bigint;

create view public.sde_category with (security_invoker = true) as
select
  _key as category_id,
  data -> 'name' ->> 'en' as name,
  (data ->> 'published')::boolean as published
from public.sde_categories;

-- K-space regions (10M id band), mirroring sde_kspace_system's convention of
-- excluding wormhole (11M) and abyssal (12M+) space. Pochven is in-band.
create view public.sde_region with (security_invoker = true) as
select
  _key as region_id,
  data -> 'name' ->> 'en' as name
from public.sde_map_regions
where _key >= 10000000 and _key < 11000000;
```

View extensions (both `create or replace`, columns **appended at the end** —
Postgres requires it, and it keeps existing callers untouched):

- `sde_published_type` gains `group_name`, `category_name` (join `sde_groups`
  → `sde_categories`; the group join is already there for `category_id`).
  Lets `get_type` and the taxonomy tools name the group/category without a
  second round trip, same motive as the region-path extension to
  `sde_kspace_system`.
- `sde_planet` gains `region_id`, `region_name`, `security` (join
  `sde_map_solar_systems` → `sde_map_constellations` → `sde_map_regions`; the
  system join is already there). This is what makes "temperate planets in
  Metropolis" a single filtered select instead of a two-step
  region→systems→planets fan-out.

No trigram indexes needed: `sde_group` (~1.5k rows), `sde_category` (~50),
`sde_region` (~70 k-space) are tiny enough that the ILIKE lookups below are
seq scans on jsonb expressions and still trivially fast.

## Loader work (PR 2: `src/sde*.ts`)

Follow the established loader shape: anon `sdeSupabase()` client, by-id
lookups cached 6h via `src/sdeCache.ts`, list/search paths uncached,
`console.error` + empty-result degradation on failure. Escape ILIKE
metacharacters (`%`, `_`, `\`) in user input before building `.ilike()`
filters, matching the search RPCs' literal-match semantics.

New `src/sdeGroups.ts`:

- `getSdeGroups(groupIDs)` / `getSdeGroup(groupID)` — cached id→
  `{ groupID, name, categoryID, categoryName, published }`.
- `searchSdeGroups(query, limit?)` — `.ilike('name', …)` over `sde_group`,
  published-only, ranked in JS by the same coverage metric as
  `searchSdeTypes` (query length / name length).
- `listSdeCategories()` / `searchSdeCategories(query)` — the ~50 categories;
  a full list is small enough to return whole.

New `src/sdeRegions.ts`:

- `searchSdeRegions(query, limit?)` — `.ilike` over `sde_region`, coverage
  ranked.
- `getRegionSystems(regionID)` — `sde_kspace_system` filtered by `region_id`,
  ordered `constellation_name, name`. The largest k-space regions are a few
  hundred systems, safely inside one PostgREST page (cap 1000), but page
  defensively anyway (reuse the `fetchAllRows` shape — it lives in `mcp/lib.ts`
  today; hoist it or duplicate the ~10 lines, decide in the PR).

Extend `src/sdeTypes.ts`:

- `getTypesInGroups(groupIDs)` — paged select over `sde_published_type` by
  `group_id`.
- `getTypesInCategory(categoryID)` — same by `category_id`. Category 9
  (Blueprint) has several thousand types, so paging is mandatory here.

Extend `src/sdePlanets.ts`:

- `getSystemPlanets(systemIDs)` — `sde_planet` by `system_id`, returning the
  existing `SdePlanet` shape (reuse `rowToPlanet`).
- `getRegionPlanets(regionID, planetTypeIDs?)` — `sde_planet` by the new
  `region_id` column, optional `.in('type_id', …)`, paged (a big region ×
  ~8 planets/system ≈ low thousands of rows; two or three pages).
- `resolvePlanetType(query)` — fuzzy planet-type input ("lava", "temperate")
  matched against the type names of **group 7 (Planet)** via
  `getTypesInGroups([7])`. No hardcoded planet-type list: CCP's names
  (`Planet (Lava)`, `Planet (Temperate)`, …) are the source of truth, and new
  planet types (Shattered, Scorched) just work.
  _As shipped:_ this split in two rather than landing in the loader — the
  fetch (`getSdeTypesInGroups([PLANET_GROUP_ID])`, a function `sdeTypes.ts`
  already had) stays in the tool, and the matching is the pure, unit-tested
  `matchPlanetTypes` in `planetQuery.ts`. Keeping the loader free of it is what
  lets `pnpm test` cover the matching without a Supabase client.

## MCP tools (PRs 3–4)

New file `src/app/api/mcp/exploreTools.ts` exporting
`registerExploreTools(server)`, called from `route.ts` next to
`registerTools`. `tools.ts` is ~1150 lines already; the static-SDE tools are a
coherent unit with no bearer-client plumbing (like `appraise_items`, they read
nothing RLS-scoped — the whole server is still behind `withMcpAuth`). They
return no `data_refreshed` stamp (nothing per-user to be stale), matching the
existing blueprint tools.

### PR 3 — exploration tools + blueprint `type_id` params

**`get_type`** — one type in full.

- Input: `type` (fuzzy name) **or** `type_id` (exact), exactly one required.
- Output: `type_id`, `name`, `group` + `group_id`, `category` + `category_id`
  (one `sde_published_type` row via the extended view), plus industry hooks:
  the blueprint that produces it (`getBlueprintForProduct` → name, activity)
  and how many blueprints consume it (`getBlueprintsForMaterial().length`),
  so the model knows which follow-up tool to call.

**`list_item_groups`** — browse the taxonomy.

- Input: optional `category` (fuzzy name or id). No args → all categories
  (id + name, published flag). With a category → its groups (id + name).
- Output is small either way; no cap gymnastics needed.

**`list_types`** — every typeID in a group or category.

- Input: `group` or `category` (fuzzy name or numeric id), exactly one;
  optional `limit` (default `MAX_ROWS = 200`, max 1000).
- Output: resolved group/category (echoing the fuzzy match the way
  `resolveOneType` reports `alsoMatched`), `total_types`, and the capped
  `types: [{ type_id, name }]` list with the standard `capNote`.

**Blueprint tools take a typeID** (edit in `tools.ts`): `blueprint_for_product`
and `blueprints_using_material` each gain an optional `product_type_id` /
`material_type_id` param; the name param becomes optional with an
exactly-one-required check. A given id skips `resolveOneType` entirely — this
is the "look at the blueprints for a given typeID" ask, and it lets `get_type`
/ `list_types` output chain straight into the industry tools without a lossy
round trip through names.

**`explore_region`** — the map, one region at a time.

- Input: `region` (fuzzy name, e.g. "metro" → Metropolis).
- Output: `region`, `region_id`, `constellation_count`, `system_count`, then
  `constellations: [{ constellation, constellation_id, systems: [{ system,
system_id, security }] }]` — grouped in JS from `getRegionSystems` rows,
  security formatted via `formatSecurity`. Region sizes are bounded (largest
  k-space region is well under 400 systems), so the full listing fits a
  response comfortably; keep a defensive cap + note anyway.
- Fuzzy misses list a few near matches, mirroring the owner-filter error shape.

**`list_planets`** — planet composition. **Shipped**, with one addition to the
spec below: a third `planet_ids` mode that resolves raw planet ids to names
(the `40099763` → `Q-UVY6 II` ask — `getSdePlanets` already did this for
`/mercenary-dens`, but no MCP tool exposed it). System mode reports the whole
system's composition and lets `planet_type` narrow only the itemized list, so
one call answers both "does it have temperate planets" and "what else is here";
region mode filters at the fetch, so its per-system breakdown covers the asked-
about types only.

- Input: `system` **or** `region` (fuzzy names, exactly one), optional
  `planet_type` (fuzzy, resolved via `resolvePlanetType`).
- System mode: resolve via `searchSdeSystems`, return
  `composition: { "Planet (Temperate)": 2, … }` plus the per-planet list
  (`name` "RXA-W1 III", `planet_id`, `type`), celestial order.
- Region mode: `getRegionPlanets(regionID, typeIDs?)`, rolled up per system:
  `systems: [{ system, security, planets: { "Planet (Lava)": 3, … },
matching_planets }]`, sorted by matching count desc then name, capped at
  `MAX_ROWS` systems with `capNote` + `total_systems`. This directly answers
  "which systems in X have temperate planets for dens" and "best lava-planet
  systems for PI".
- Planet type names resolve through `getSdeTypeNames` — never hardcoded.
- Note in the tool description that coverage is k-space (the mirror's planet
  rows exist for wormhole systems, but region mode filters to k-space regions
  and system mode resolves through the k-space system search).

### PR 4 — `search_assets` by group/category

Extend the existing tool in `tools.ts` (+ `resolveTypeFilter` in `lib.ts`):

- New optional params `group` and `category` (fuzzy name or id). `item`
  becomes optional; require at least one of the three.
- Resolution: group/category → `getTypesInGroups` / `getTypesInCategory` →
  type-id set; when `item` is also given, intersect the sets (so
  `item: "vexor", category: "ship"` works and `item` alone behaves exactly as
  today).
- The `MAX_TYPES = 100` guard exists to stop an accidentally broad _substring_
  from walking the hangar. A whole group/category is a deliberate ask, so the
  taxonomy path gets its own, higher ceiling (~2000 type ids — category 6
  "Ship" is ~600 published types and must fit; category 9 stays excluded by
  the existing blueprint default). The ids travel in the
  `character_asset_search` / `corp_asset_search` RPC body (`type_id =
any(...)`), so there's no URL-length concern; both functions seed from the
  matched rows (the cheap seeded-recursion shape), so a bigger id list stays
  cheap.
- Response gains the resolved `group`/`category` echo; `totals_by_item`
  already gives the per-type rollup a category search wants.

## Delivery: PR stack

Same expand-contract discipline as the SDE cutover stack — each PR builds,
lints, and ships alone:

| PR                          | Scope                                                                                                                                                                                                                            | Files                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **1 — DB views**            | Migration: `sde_group` / `sde_category` / `sde_region` views; append `group_name`/`category_name` to `sde_published_type` and `region_id`/`region_name`/`security` to `sde_planet`; grants; `schema.sql` SDE section + drop list | `supabase/migrations/…`, `schema.sql` |
| **2 — loaders**             | `sdeGroups.ts`, `sdeRegions.ts`; extend `sdeTypes.ts` (`getTypesInGroups`/`getTypesInCategory`) and `sdePlanets.ts` (`getSystemPlanets`/`getRegionPlanets`/`resolvePlanetType`)                                                  | `src/sde*.ts`                         |
| **3 — exploration tools**   | `exploreTools.ts` (`get_type`, `list_item_groups`, `list_types`, `explore_region`, `list_planets`), register in `route.ts`; `type_id` params on the two blueprint tools                                                          | `src/app/api/mcp/`                    |
| **4 — asset search filter** | `group`/`category` params on `search_assets`; taxonomy path in `resolveTypeFilter`                                                                                                                                               | `src/app/api/mcp/tools.ts`, `lib.ts`  |

PRs 3 and 4 are independent of each other; both depend on 2, which depends
on 1. CLAUDE.md's MCP-server section and codebase-map entries update in each
PR that changes a documented surface. Never rename PR 1's migration file once
pushed (see Workflow rules); a follow-up fix is a new migration.

## Verification

No test runner in this repo. Per PR:

- `pnpm run build` + `pnpm run lint` (the loaders and tools are exercised at
  type level; the views' column names are pinned by the row types).
- PR 1: run the migration against a branch/staging DB and spot-check —
  `select * from sde_region order by region_id limit 5`, a
  `sde_planet` row's `region_name`, a `sde_published_type` row's
  `category_name`.
- PR 3/4: exercise the deployed MCP endpoint with real prompts — "which
  systems in Metropolis have temperate planets", "list all the frigate hulls",
  "what are my ships worth" (category search → appraise chain), "show me the
  blueprint for type 645".

## Non-goals

- No ESI calls and no new extract jobs — everything is SDE-mirror or existing
  RLS-scoped RPCs.
- No wormhole/abyssal coverage in region tools (consistent with
  `sde_kspace_system`).
- No PI-yield math (resource richness isn't in the SDE) — `list_planets`
  reports composition, not planetology stats. If CCP's export later carries
  more per-planet attributes, the `sde_planet` view is the extension point.
- No route/API-endpoint additions outside `/api/mcp` — "endpoints" here means
  MCP tools.

## Open questions

- **Region rollup in SQL vs JS:** region-mode `list_planets` pulls a few
  thousand `sde_planet` rows and aggregates in JS. If that proves slow or
  heavy, the fallback is an `sde_region_planet_summary(region_id)` RPC
  returning one row per (system, planet type) — noted here so the migration
  doesn't need it speculatively.
- **Tool count:** this takes the server from 8 to 13 tools. That's still
  modest, but if it grows further, the taxonomy browsers (`list_item_groups`,
  `list_types`, `get_type`) are the candidates to merge into one
  `explore_types` tool with a mode discriminator.
- **`fetchAllRows` home:** it's MCP-lib-local today but PR 2's loaders need
  paging too — hoist to `src/utils/` or keep a loader-local copy; either is
  fine, pick one in PR 2.
