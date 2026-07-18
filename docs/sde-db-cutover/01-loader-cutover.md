# Stage 1: cut the SDE loaders over to the database, stop downloading the SDE at build time

> **Delivered as an incremental PR stack, not one big PR.** An earlier
> single-PR attempt (#617, closed unmerged) touched 26 files at once because the
> loaders flip sync → async in lockstep with every caller. This stage is now
> split into the stack in [Delivery](#delivery-incremental-pr-stack) below. The
> **Goal / Prerequisite / Step / consumer** sections that follow are the full
> end-state spec — read them as the destination; the stack is how we get there.

## Goal

After this PR, `pnpm run build` no longer downloads CCP's SDE for the app:

- The five loader modules — `src/sdeTypes.ts`, `src/sdeSystems.ts`,
  `src/sdeStations.ts`, `src/sdeBlueprints.ts`, `src/sdePlanets.ts` — stop
  reading `src/generated/*.json` (`readFileSync`) and instead query the
  `sde_*` views/RPCs in Supabase. Their exported function names stay the
  same, but **every data function becomes `async`**.
- Every consumer of those functions gains `await` (and, where a sync
  predicate was used inside `.map()`, switches to a bulk-fetch-then-Set
  pattern; details per file below).
- `src/buildSde.js` is deleted; the `sde:build` script is removed;
  `predev`/`prebuild` become `"pnpm run esf:build"` only.
- `esf:build` / `src/buildEsfData.js` (ship-fitting protobufs) are **not
  touched** — that's a separate, optional, later PR (doc 03).

## Delivery: incremental PR stack

The sync → async signature flip is the one breaking change: every caller of a
loader must gain `await` in the same PR that converts it. Two facts make the
stage splittable anyway, so each PR stays small, builds, lints, and deploys on
its own:

1. **The five loaders are independent modules** — each reads its own data and
   has its own consumers, so `sdeStations` can go async while `sdeTypes` stays
   sync+JSON.
2. **The mirror is already populated in prod** (nightly `sde-mirror`, #607) and
   the build keeps emitting the JSON until the very last PR — so a *half*-
   migrated app works: migrated loaders read the DB, the rest read JSON. Every
   intermediate state is shippable, and the never-cache-misses rule (see
   `src/sdeCache.ts`) means even a fresh/empty table degrades to `#id`
   fallbacks rather than 500s.

This is a standard expand-contract migration. The stack, smallest/most-isolated
first:

| PR | Scope | Consumers touched |
|----|-------|-------------------|
| **1 — infra + stations** ✅ | Add `src/utils/supabase/sde.ts` (anon client) + `src/sdeCache.ts` (`createByIdCache` + `bulkLookup`); migrate `sdeStations` → async DB-backed as the first loader | `stationNames.ts` |
| **2 — planets** ✅ | `sdePlanets` → async; drop its `sdeSystems` import (the `sde_planet` view carries `system_name`) | `mercenary-dens` |
| **3 — systems** ✅ | `sdeSystems` → async, add `getSdeSystems` bulk helper | `systemNames`, `indexes` page + actions, `mcp/tools` (`resolveSystemNames`) |
| **4 — blueprints** ✅ | `sdeBlueprints` → async | `mcp/tools` (2 fns) |
| **5 — types** ✅ | `sdeTypes` → async, `getSdeTypes` bulk, `SdeSearchResult` gains `categoryID` (drops per-row category lookups) | the big fan-out: `typeNames`, `blueprint/api`, `type/search`, `asset/search`, `asset/[locationId]`, `ship/[itemId]`, `corpses`, `mercenary-dens`, `mcp/lib` + `tools` |
| **6 — contract** ✅ (this PR) | Delete `src/buildSde.js` + the `sde:build` script; `predev`/`prebuild` → `esf:build` only; drop `/src/generated` from `.gitignore`; finish the Commands/Architecture/build-pipeline prose in CLAUDE.md. Folds in **doc 03**: `esf:build` now reads the `sde_*` mirror too (no CCP download, no `unzip`), so the build downloads nothing from CCP | `buildEsfData.js` |
| **6 — contract** | Delete `src/buildSde.js`, drop the `sde:build` script, `predev`/`prebuild` → `esf:build` only, remove `/src/generated` from `.gitignore`, finish the CLAUDE.md prose | none |

Ordering notes: PRs 2–5 are mutually independent (a shared consumer like
`mcp/tools.ts` is touched by several, each awaiting only the loader it's
migrating — the file compiles at every step because the others are still sync).
Only PR 1 (must be first — it adds the shared client/cache) and PR 6 (must be
last — the contract step) are ordered. Each loader PR updates that loader's
section in CLAUDE.md; the Commands/Architecture/build-pipeline prose lands with
PR 6. (PR 6 also folded in doc 03 — pointing `esf:build` at the mirror — so the
build downloads nothing from CCP. Note: with `esf:build` reading Supabase,
`pnpm build` now needs `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` + a populated
mirror, so the Vercel preview build is the end-to-end gate rather than a bare
local `pnpm build`.) If PR 5 (types) still feels too large, it can split again
by consumer cluster, since `getSdeTypeNames` can go async before
`searchSdeTypesAll` does.

## Prerequisite

The mirror must be populated: run
`select count(*) from sde_types;` — expect tens of thousands of rows — and
`select count(*) from sde_blueprint_product;` — expect thousands. If empty,
kick the ingest first:
`curl -H "Authorization: Bearer $CRON_SECRET" "https://<app>/api/cron/sde-mirror?force=1"`.

## Step 1 — a dedicated Supabase client for SDE reads

The SDE tables are public-read (see the README), so the loaders don't need
the cookie-session client (`src/utils/supabase/server.ts`), the bearer client
(MCP), or the service role. A plain anon client works identically from server
components, route handlers, server actions, MCP tool handlers, and anonymous
pages (`/corpses/[characterID]`), and avoids threading a client parameter
through every loader signature.

New file `src/utils/supabase/sde.ts`:

```ts
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// The SDE mirror tables (sde_*) are public-read static data — RLS grants
// SELECT to anon — so one module-level anon client serves every context
// (server components, route handlers, MCP tools, anonymous share pages)
// without cookie or bearer plumbing. Never used for writes.
let client: SupabaseClient | null = null

export const sdeSupabase = (): SupabaseClient => {
  if (client) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY
  if (!url || !key) throw new Error('sde: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}
```

(Lazy so importing the module never throws at build time when env vars are
absent — the same reason the queue consumer lazy-imports job modules.)

## Step 2 — caching policy (applies to all five loaders)

- SDE data changes at most once per game patch and the mirror refreshes
  nightly, so a **module-level `Map` cache with a 6-hour TTL** on *by-id*
  lookups is safe and keeps hot paths (type names render on every page) at
  zero DB round-trips after warm-up.
- **Cache only found rows. Never cache misses.** On a fresh deploy before the
  first ingest the tables are empty; caching `null` for 6 hours would keep
  names broken long after the ingest lands. A miss must re-query next call.
- Searches (`sde_search_*` RPCs) and blueprint lookups are **not** cached —
  they're user-action paths, not per-row render paths.
- Suggested shared shape (put a tiny helper in each loader or a shared
  `src/sdeCache.ts`; keep it simple):

```ts
const TTL_MS = 6 * 60 * 60 * 1000
type Cached<T> = { value: T; at: number }
// get: hit if (Date.now() - at) < TTL_MS
```

- Bulk lookups: PostgREST caps responses at 1000 rows (`max_rows`), so chunk
  `.in('col', ids)` queries at **500 ids per request** (ramda `splitEvery`)
  and merge. Filter the id list through the cache first so only unknown ids
  hit the DB.

## Step 3 — rewrite the loaders

Keep each module's exported names and TypeScript shapes identical except
where noted. Full template for `sdeTypes.ts` (the others follow the same
pattern):

```ts
// DB-backed lookup over the nightly SDE mirror (sde_published_type view and
// sde_search_type RPC — see supabase/migrations/20260716010000_sde_mirror.sql
// and src/jobs/sdeMirror.js). Replaces the build-time generated JSON: data
// now refreshes nightly without a rebuild. By-id lookups are cached per
// server process for 6h; misses are never cached (a fresh DB before the
// first ingest must not poison the cache).
import { splitEvery } from 'ramda'

import { sdeSupabase } from '@/utils/supabase/sde'

export type SdeType = { typeID: number; name: string; groupID: number; categoryID: number | null }

const TTL_MS = 6 * 60 * 60 * 1000
const cache = new Map<number, { value: SdeType; at: number }>()

const cached = (id: number): SdeType | null => {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  return null
}

const rowToType = (r: { type_id: number; name: string; group_id: number; category_id: number | null }): SdeType => ({
  typeID: r.type_id,
  name: r.name,
  groupID: r.group_id,
  categoryID: r.category_id,
})

// Bulk fetch: cache-filter, then chunked .in() queries (PostgREST caps
// responses at 1000 rows; 500 keeps well clear).
export const getSdeTypes = async (typeIDs: Iterable<number>): Promise<Record<number, SdeType>> => {
  const result: Record<number, SdeType> = {}
  const missing: number[] = []
  for (const id of new Set(typeIDs)) {
    const hit = cached(id)
    if (hit) result[id] = hit
    else missing.push(id)
  }
  for (const chunk of splitEvery(500, missing)) {
    const { data, error } = await sdeSupabase()
      .from('sde_published_type')
      .select('type_id, name, group_id, category_id')
      .in('type_id', chunk)
    if (error) {
      console.error(`[sdeTypes] lookup failed: ${error.message}`)
      continue // degrade to raw-id fallbacks, don't take the page down
    }
    for (const r of data ?? []) {
      const t = rowToType(r)
      result[t.typeID] = t
      cache.set(t.typeID, { value: t, at: Date.now() })
    }
  }
  return result
}

export const getSdeType = async (typeID: number): Promise<SdeType | null> =>
  (await getSdeTypes([typeID]))[typeID] ?? null

export const getSdeTypeNames = async (typeIDs: Iterable<number>): Promise<Record<number, string>> => {
  const types = await getSdeTypes(typeIDs)
  return Object.fromEntries(Object.entries(types).map(([id, t]) => [id, t.name]))
}

export type SdeSearchResult = { typeID: number; name: string; coverage: number; categoryID: number | null }

// Search via the sde_search_type RPC, which reproduces the old in-memory
// ranking exactly (coverage desc, shorter name, then id) and now also returns
// category_id so callers can filter without per-row getSdeType calls.
// CHANGE from the JSON era: results cap at 1000 (PostgREST max_rows). Every
// existing "too many results" guard triggers far below that — verify the
// constant at the call site (src/app/asset/search/page.tsx) is < 1000.
export const searchSdeTypesAll = async (query: string): Promise<SdeSearchResult[]> => {
  if (query.trim() === '') return []
  const { data, error } = await sdeSupabase().rpc('sde_search_type', { q: query, lim: 1000 })
  if (error) {
    console.error(`[sdeTypes] search failed: ${error.message}`)
    return []
  }
  return (data ?? []).map((r: any) => ({
    typeID: r.type_id,
    name: r.name,
    coverage: r.coverage,
    categoryID: r.category_id,
  }))
}

export const searchSdeTypes = async (query: string, limit = 25): Promise<SdeSearchResult[]> => {
  if (query.trim() === '') return []
  const { data, error } = await sdeSupabase().rpc('sde_search_type', { q: query, lim: limit })
  if (error) {
    console.error(`[sdeTypes] search failed: ${error.message}`)
    return []
  }
  return (data ?? []).map((r: any) => ({
    typeID: r.type_id,
    name: r.name,
    coverage: r.coverage,
    categoryID: r.category_id,
  }))
}
```

Error philosophy: a DB hiccup logs and returns empty — every consumer already
renders `#id` fallbacks (see `src/app/names.tsx`) — it must never throw a page
into the error boundary. Follow this in all five loaders.

### `src/sdeSystems.ts`

- `SdeSystem = { systemID: number; name: string; security: number }`.
- `getSdeSystems(ids)` (new bulk helper) + `getSdeSystem(id)` +
  `getSdeSystemNames(ids)` over `sde_kspace_system`
  (`system_id, name, security`), same cache pattern as types.
- `searchSdeSystems(query, limit = 25)` → `rpc('sde_search_system', { q, lim })`,
  mapping `system_id → systemID`; return shape stays `(SdeSystem & { coverage })[]`.
- `formatSecurity(security)` stays **sync and pure** — untouched.

### `src/sdeStations.ts`

- `SdeStation = { stationID: number; name: string; systemID: number }`.
- One bulk fetch over the `sde_station` view (`station_id, name, system_id`)
  feeds all three exports: `getSdeStation(id)`, `getSdeStationNames(ids)`,
  `getSdeStationSystems(ids)`. Same cache pattern.
- Note: `sde_station` inner-joins the ESI-resolved name table, so a station
  missing a name is simply absent — exactly the old JSON behavior (the build
  filtered out unnamed stations).

### `src/sdeBlueprints.ts`

- Keep `MANUFACTURING = 1`, `REACTION = 11`, and the `Blueprint` /
  `BlueprintMaterial` types exactly as they are
  (`Blueprint = { blueprintTypeID, activityID, productTypeID, productQuantity,
  materials: BlueprintMaterial[] }`, `BlueprintMaterial = { typeID, quantity }`).
- Row mapping from `sde_blueprint_product`: `blueprint_type_id`,
  `activity_id`, `product_type_id`, `product_quantity`, and `materials` is
  already CCP's `[{typeID, quantity}, …]` jsonb — map it defensively
  (`(m: any) => ({ typeID: m.typeID, quantity: m.quantity })`) and sort by
  `typeID` to preserve the old deterministic order.
- `getBlueprintForProduct(productTypeID)`:
  `.from('sde_blueprint_product').select('*').eq('product_type_id', id)`,
  then pick in JS: prefer `activity_id === MANUFACTURING` over `REACTION`,
  tie-break lowest `blueprint_type_id` (this reproduces the old selection
  exactly).
- `getBlueprintsForMaterial(materialTypeID)`:
  `.contains('materials', [{ typeID: materialTypeID }])` (the GIN
  `jsonb_path_ops` index serves this containment probe), sorted by
  `product_type_id` in JS.
- No cache needed (used by the two MCP blueprint tools and the blueprint
  pages — low volume).

### `src/sdePlanets.ts`

- Keep `TEMPERATE_PLANET_TYPE_ID = 11` and `toRoman(n)` sync/pure.
- `getSdePlanets(ids)` / `getSdePlanet(id)` over the `sde_planet` view, which
  already carries `system_name` — **drop the import of `getSdeSystem` from
  sdeSystems** (the old cross-loader dependency). Derive
  `name = system_name ? `${system_name} ${toRoman(celestial_index)}` : `Planet #${id}``
  matching the current fallback behavior. Same cache pattern.
- Keep the returned `SdePlanet` shape identical
  (`{ planetID, systemID, systemName, celestialIndex, typeID, roman, name }` —
  verify the exact current fields in the file before rewriting).

## Step 4 — ripple `await` through the consumers

Every call site below is in an async server context already (server
components, route handlers, server actions, MCP handlers), so adding `await`
is mechanical. The non-mechanical ones are flagged. **Grep for every import
from the five loaders when done** (`rg "from '@/sde"` and relative variants)
to be sure nothing was missed.

| File | Change |
|---|---|
| `src/app/typeNames.ts` | `fetchTypeNames` already returns a Promise; body becomes `await getSdeTypeNames(ids)` |
| `src/app/systemNames.ts` | `await getSdeSystemNames(...)` first, then the existing `universe_name` DB fallback for ids the SDE didn't resolve (wormhole systems) — keep that fallback |
| `src/app/stationNames.ts` | `await getSdeStationNames(...)` + keep `universe_name` fallback; `fetchStationSystems` awaits `getSdeStationSystems` |
| `src/app/blueprint/api.ts` | `await searchSdeTypes(...)` in `searchBlueprints`/`resolveProductTypeID`; `await getSdeType(...)` in `fetchType`. The `.name.endsWith('Blueprint')` filtering keeps working on RPC results |
| `src/app/api/type/search/route.ts` | `NextResponse.json(await searchSdeTypes(q))` |
| `src/app/asset/search/page.tsx` | `await searchSdeTypesAll(query)`. **Simplification**: the page currently calls `getSdeType` per match to read `categoryID` for its exclude-blueprints filter — the search results now carry `categoryID`, so filter on that directly (no per-row lookups). The "too many results" check keeps using `.length`; verify its threshold constant is < 1000 (the new hard cap) |
| `src/app/asset/[locationId]/page.tsx` | The sync `isShip(typeId)`-style predicate (categoryID === ship category) is used inside row mapping. Bulk-fetch once: `const types = await getSdeTypes(uniqueTypeIds)` then build a `Set<number>` of ship type ids and use sync `Set.has` in the map |
| `src/app/ship/[itemId]/page.tsx` | Same bulk-then-Set treatment as above |
| `src/app/indexes/page.tsx` | Per-row `getSdeSystem(id)` → one `await getSdeSystems(ids)` before mapping; `formatSecurity` unchanged |
| `src/app/indexes/actions.ts` | `await searchSdeSystems(query, 8)`; the watch-system validation awaits `getSdeSystem` |
| `src/app/corpses/[characterID]/page.tsx` | `await searchSdeTypesAll('corpse')`. Note this page runs for anonymous visitors — the anon SDE client covers it |
| `src/app/mercenary-dens/page.tsx` | `await getSdeTypeNames(...)`; per-den `getSdePlanet(planet_id)` → one bulk `await getSdePlanets(planetIds)` then index into the record |
| `src/app/api/mcp/lib.ts` | **Exported-signature change**: the shared type-resolution helper (`resolveTypeFilter` and friends) becomes `async` — it currently uses `searchSdeTypesAll` + per-result `getSdeType` for blueprint-category filtering; use the `categoryID` now on each search result instead. Update every caller in `tools.ts` |
| `src/app/api/mcp/tools.ts` | `await` at each of the ~12 SDE call sites (`getSdeTypeNames`, `getSdeSystem`, `getSdeSystemNames`, `searchSdeSystems`, `getSdeType`, `getBlueprintForProduct`, `getBlueprintsForMaterial`); all inside async tool handlers already. Where a sync per-row lookup feeds a `.map()`, use the bulk-then-index pattern |

## Step 5 — delete the build-time pipeline

- Delete `src/buildSde.js`.
- `package.json`: remove the `"sde:build"` script; change **both**
  `"predev"` and `"prebuild"` to `"pnpm run esf:build"`.
- `.gitignore`: if `/src/generated/` is listed solely for the SDE JSON (check
  — `esf:build` writes to `public/esf-data/`, not `src/generated/`), remove
  the entry; nothing writes there anymore.
- Grep for any straggler references to `src/generated/sde` or `buildSde`
  (comments included) and clean them up.

## Step 6 — CLAUDE.md

Update every section that describes the old pipeline (grep CLAUDE.md for
`sde:build`, `buildSde`, `src/generated`, `sdeTypes.json`):

- **Commands**: delete the `pnpm run sde:build` bullet; note `predev`/
  `prebuild` now run only `esf:build`.
- **Data sources / Architecture**: lookups now come from the nightly-mirrored
  `sde_*` tables via the async loaders in `src/sde*.ts`; the `sde-mirror` job
  keeps them fresh; still never Fuzzwork.
- **Codebase map → buildSde.js section**: delete it. Rewrite the five
  `src/sde*.ts` entries as async DB-backed (note the new bulk helpers
  `getSdeTypes`/`getSdeSystems` and that `SdeSearchResult` gained
  `categoryID`).
- Mention `src/utils/supabase/sde.ts` alongside the other client factories.

## Verification (all of it, in order)

1. `pnpm run lint`.
2. `rm -rf src/generated && pnpm run build` — must succeed (proves nothing
   reads the JSON anymore; `esf:build` still runs for `public/esf-data/`).
3. Against a DB with a completed ingest (`sde_mirror_state.completed_at` set),
   `pnpm run dev` and exercise:
   - `/asset` and `/asset/[locationId]` — type/station/system names render.
   - `/asset/search?...` with a common term (`rifter`) and a huge one
     (`blueprint`) — results and the "too many" guard both behave.
   - `/ship/[itemId]` — the isShip redirect logic works both directions.
   - `/blueprint` search + a `/blueprint/[typeID]` page.
   - `/indexes` — security decimals + the watch-a-system autocomplete
     (server action).
   - `/mercenary-dens` and `/corpses/[characterID]` (the latter in a
     logged-out window).
   - `/api/type/search?q=trit` returns JSON results.
   - MCP: `blueprint_for_product` and `search_assets` via an MCP client.
4. Cold-start check: against an **empty** `sde_types` (truncate on a scratch
   DB or point at a fresh project), pages must render with `#id` fallbacks —
   no 500s — and after populating, names must appear **without a server
   restart** (this is the never-cache-misses rule working).
5. Latency sanity: `/asset` should add roughly one round-trip for the bulk
   name query on a cold cache and ~zero warm. If a page got visibly slower,
   look for a per-row `await` that should be a bulk call.

## Gotchas

- **Do not** import the loaders from client components (`'use client'`) —
  they're server-only. Today nothing does; keep it that way (names flow to
  the client as resolved strings/promise props, e.g. `src/app/typeName.tsx`).
- PostgREST returns bigint columns as JSON numbers — fine for every EVE id
  (they're far below 2^53), no string handling needed.
- The old `searchSdeTypesAll` was truly unbounded; the RPC caps at 1000.
  Checked call sites: the asset-search "too many" guard (threshold well under
  1000) and the corpse-type lookup (a handful of matches). If a future call
  site genuinely needs >1000 matches, it needs a different query, not a
  bigger cap.
- `sdePlanets` must not import from `sdeSystems` anymore — the view provides
  `system_name`. Removing the cross-import also removes a subtle
  double-cache.
