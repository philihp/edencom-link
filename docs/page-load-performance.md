# Plan: page-load performance (slow link → new page transitions)

Clicking a link to a heavy page — opening an asset location with lots of
items, a big ship, the fitting matrix — can leave the app looking dead for
several seconds: the old page just sits there until the new one arrives all
at once. This plan separates that experience into its two real causes and
stages the fixes so cheaper models can implement each phase independently.

## The two distinct problems

**A. No feedback during navigation.** In the App Router, a `<Link>` to a
dynamically-rendered route renders _nothing_ until the target page's server
component tree resolves — unless the route segment has a `loading.tsx` (or
the page wraps itself in `<Suspense>`). This repo has **zero `loading.tsx`
files**. So even a 2-second page feels broken, because for those 2 seconds
the click appears to have done nothing. `src/app/asset/page.tsx` already
works around this for itself with a page-level `<Suspense fallback={…}>`,
but that pattern is per-page and only kicks in once the request reaches the
server; nothing covers the rest of the app.

A second-order effect: for dynamic routes, `<Link>` prefetching only
prefetches _up to the nearest loading boundary_. With no `loading.tsx`
there is nothing to prefetch, so navigation can't even paint an
instant shell from cache.

**B. The server genuinely takes a while.** The worst page,
`src/app/asset/[locationId]/page.tsx`, is a long chain of **sequential**
awaits — root items + contents RPCs, then the self lookup (two queries,
serialized), share-dialog data, the bulk SDE type lookup, the breadcrumb
(`asset_ancestors()` RPC) _or_ the structure/station/system resolution
chain (itself several serialized awaits), the system-locations summary
RPCs, owners. Each await is a round trip from the Vercel function to
Supabase; a dozen serialized round trips is a dozen × RTT before a single
byte of HTML is sent, on top of the queries that are intrinsically heavy
(`*_asset_location_contents()` walks the entire subtree of every container
at the location).

Fixing A without B gives a page that responds instantly but still makes
you wait at a skeleton. Fixing B without A still leaves clicks feeling
dead. We want both, in that order — A is cheap and universal, B is
per-page work.

## Options considered

### 1. `loading.tsx` route fallbacks — yes, phase 1

The canonical App Router answer to problem A. A `loading.tsx` in a route
segment gives every navigation into that segment an instant fallback (it
implicitly wraps the page in a Suspense boundary), and makes dynamic-route
prefetching useful (the shell up to the boundary is prefetchable). Cheap,
mechanical, no data-layer changes. Downsides: it's a whole-page fallback
(the header/footer from `layout.tsx` stay, everything below swaps to the
skeleton), and a generic spinner loses the context of what's loading —
acceptable for phase 1, refined by streaming in phase 2.

### 2. `useLinkStatus` pending indicators — yes, phase 1

Next 15.3+ ships `useLinkStatus` (a hook usable in a client component
_inside_ a `<Link>`) that reports the pending state of that specific
navigation. A tiny shared `<LinkSpinner />` rendered inside heavy links
(asset table rows, the fitting matrix cells, structure lists) shows a
spinner _at the click site_ during the server wait. This covers the gap
`loading.tsx` can't: the time before the new segment's shell swaps in, and
it tells the user _which_ click is in flight. Purely additive client-side
polish.

### 3. In-page Suspense streaming — yes, phase 2

The actual Next.js best practice for problem B's _perceived_ half: don't
await everything at the top of the page function; render the cheap shell
(heading, breadcrumb, filter chrome) immediately and let the expensive
sections stream in when ready. Two patterns, both already proven in this
repo:

- **Suspended server component**: `/asset/page.tsx` wraps `<Locations />`
  in `<Suspense>`; the shell flushes first, the table streams when its
  RPCs resolve. Generalize: move each heavy section's awaits _into_ a
  child server component and wrap it.
- **Promise-passing to client cells**: `typeName.tsx` takes an unresolved
  `Promise<Record<number, string>>` and resolves it per-cell with
  `use()` + `<Suspense>` fallbacks — the table paints with `#id`
  placeholders and names pop in. `[locationId]/page.tsx` already does this
  for type names (`typeNamesPromise`).

One structural caveat for `[locationId]`: the **ship redirect** (an item
that turns out to be a ship 302s to `/ship/[itemId]`) depends on the self
lookup + SDE category — that decision must stay in the blocking prefix of
the page (before the shell flushes), or the user sees a container shell
flash before being redirected. Same for the auth `redirect('/')`. Everything
_after_ those two decisions is streamable.

### 4. Kill the query waterfall — yes, phase 2/3

The _actual_ half of problem B. Two tiers:

- **Parallelize what's independent (phase 2, free):** the self lookups,
  share data, owners, and the heading-resolution chain have real data
  dependencies in places, but much of the current serialization is
  incidental — e.g. `characterSelf` then `corpSelf` are two round trips
  where one `Promise.all` (or a single UNION query) would do; `fetchOwners`
  depends on nothing and currently waits for everything above it.
  Restructuring for Suspense (option 3) naturally forces this: each
  suspended section starts its own fetches immediately and they overlap.
- **Push per-page aggregation into one RPC (phase 3, a migration):** this
  repo's strongest precedent — `*_asset_location_summary()` replaced
  paging every asset into Node, `blueprint_search()` put all of
  `list_blueprints`' filtering in SQL. A
  `asset_location_page(location_id)` function could return root items +
  per-container contents counts + the self row + the resolved heading
  inputs as one json object in **one** round trip, SECURITY INVOKER so RLS
  scopes it exactly like today's separate selects. Do this only after
  phase 2, and only if the streamed page is still slow — measure first.

### 5. Caching / PPR / `use cache` — no (for now)

Almost everything these pages render is per-user, RLS-scoped, cookie-
authenticated data — the static shell is trivially small, so Partial
Prerendering buys little, and caching player data across requests risks
cross-user leaks for negligible win. The read-heavy _static_ data (SDE
lookups) is already process-cached for 6h in `src/sdeCache.ts`. Revisit
only if profiling shows SDE round trips dominating a hot page on cold
lambdas.

### 6. Router cache tuning (`staleTimes`) — **yes, reversed**

> **This was originally a "no" and the reasoning was wrong.** It said
> `staleTimes` trades staleness of player data (freshness being a product
> feature — see `freshness.ts`) for back-navigation speed the bfcache mostly
> covers anyway. Two errors: the bfcache does not cover in-app client
> navigation, and there is no freshness to trade — the extract jobs run every
> six hours, so a segment reused within a minute cannot differ from a fresh
> render. In practice `staleTimes.dynamic` defaults to **0**, and every page
> here is dynamic (cookie session), so the router cache was holding nothing at
> all: each back/forward re-ran the entire server render. Set to 60s in
> `next.config.mjs`. Kept to 60 rather than the 300s ceiling because the
> header's freshness indicator rides on these same renders and should not sit
> visibly behind an on-demand refresh.

## The plan

### Phase 1 — instant feedback everywhere (no data-layer changes)

1. Add `loading.tsx` to every heavy route segment. Each is a few lines:
   reuse the page's real heading structure where it's statically known
   (like `AssetsLoading` in `asset/page.tsx` does) rather than a bare
   spinner. Segments, worst first:
   - `src/app/asset/[locationId]/` (also covers drill-down between
     locations — self-navigation within the same segment re-triggers it)
   - `src/app/ship/[itemId]/`
   - `src/app/asset/search/`
   - `src/app/fitting/` and `src/app/fitting/[characterId]/[fittingId]/`
   - `src/app/industry/`, `src/app/market/`, `src/app/structure/`,
     `src/app/structure/[structureId]/`, `src/app/structure/revenue/`
   - `src/app/blueprint/[typeID]/`, `src/app/character/refresh/`,
     `src/app/mercenary-dens/`
2. Convert `/asset/page.tsx`'s hand-rolled Suspense to `loading.tsx` for
   consistency (`AssetsLoading` becomes the file), or leave it — either is
   fine; don't have both.
3. Add a shared `LinkSpinner` client component (`useLinkStatus`) and drop
   it into the highest-traffic link sites: the assets tables
   (`assetsTable.tsx`, `locationAssets.tsx`, `systemLocations.tsx`), the
   fitting matrix, structure lists.

Verification: `pnpm run build && pnpm run lint`; click around `pnpm run
dev` with throttled network and confirm every heavy navigation paints a
fallback immediately.

### Phase 2 — stream the heavy pages, fix incidental waterfalls

Per page (start with `asset/[locationId]`, the worst):

1. Split the page into a **blocking prefix** — auth redirect, share-scope
   resolution, the self lookup + SDE category check that decides the ship
   redirect, and the heading — and **suspended sections** for the rest
   (the items table with its contents counts, the system-locations
   directory, the share dialog data, owners for the filter).
2. Inside each section, fire independent queries together
   (`Promise.all`), and collapse the incidental serializations (the
   character/corp self probe pair; owners waiting on unrelated work).
3. Keep the existing promise-streaming for type names; extend the same
   pattern where a whole column is the slow part rather than a section.
4. Same treatment for `/ship/[itemId]` (its `LocationAssets` +
   fit-viewer data) and `/fitting` (matrix bucketing).

Verification: build + lint; the shell (breadcrumb + heading + table
chrome) should flush well under a second on dev against production data,
with sections streaming in after.

### Phase 3 — one round trip per page (only if still needed)

If, after phase 2, Speed Insights still shows `asset/[locationId]` TTFB/
LCP dominated by query time: add an `asset_location_page(location_id)`
SECURITY INVOKER function (edit `schema.sql` **and** add a
`supabase/migrations/` migration, per house rules) folding root items,
contents counts, self row, and heading-resolution inputs into one json
response, and collapse the page's fetch prefix onto it. Follow the seeded
recursion shape of `character_asset_search()`, not the walk-everything
shape, for the contents counts.

### Phase 4 — measure

`@vercel/speed-insights` is already wired in `layout.tsx`. Before phase 1
lands, note the current p75 for the worst routes; after each phase,
compare. No new tooling needed.

## What measurement actually found

Phase 4 said to measure before doing more. It was worth it — the biggest wins
were not where this plan predicted, and phase 3's premise turned out to be
wrong.

|                                                                       |                      |
| --------------------------------------------------------------------- | -------------------- |
| `asset_ancestors()` (breadcrumb, blocking)                            | **3,199 ms → 59 ms** |
| `character_asset_location_summary()` (index + system pages, blocking) | 970 ms → 588 ms      |
| `corp_asset_location_summary()`                                       | 257 ms → 126 ms      |
| `character_asset_location_contents()`                                 | 128 ms → 63 ms       |
| root items                                                            | 34 ms → 0.8 ms       |

None of it was round-trip count, which is what phases 2 and 3 were aimed at.
It was three query-level faults:

1. **A materialized CTE.** `asset_ancestors`' `parent_of` is referenced twice,
   so Postgres built all ~117k current asset rows and filtered to one, with the
   `item_id` index unused. `not materialized` fixed it.
2. **A hash join against jsonb.** The same function joined `sde_published_type`
   for one row; with a recursive-CTE row estimate of 41,202 against an actual 1,
   the planner hashed the whole view — a seq scan parsing 52,848 jsonb
   documents. A scalar subquery made it one index probe.
3. **A missing index.** Nothing indexed `location_id`, anywhere, so every
   location query scanned the full current snapshot.

(1) and (2) shipped in `20260807000000`, along with the indexes; the summary
narrowing in `20260807010000`.

**Phase 3 as written is dead.** It proposed folding the location page's fetch
prefix into one `asset_location_page()` RPC, gated on measurement. Measurement
says the prefix was never the problem — it was ~35 ms of round trips behind a
3.2 s query. Collapsing them would have saved tens of milliseconds while the
real fault sat untouched. Do not build it.

What replaces it, if the index page still feels slow: the summary functions
still walk every current asset up its container chain on every request, to
produce ~1.5k rows from data that changes every six hours. The fix is to stop
recomputing per request — a rollup table maintained by the `character-assets`
extract, turning the page read into an indexed select. Considered and rejected
for the same job: wrapping the RPCs in Next's data cache, since the key would
have to carry the user id and a wrong key serves one player another player's
hangar.

Reach for `EXPLAIN ANALYZE` before reasoning about waterfall depth next time.

## Non-goals

- No caching of player data **on the server**, shared across users or
  requests (RLS makes a mis-keyed cache a data leak). The per-client router
  cache is a different thing and is now on — see option 6.
- No PPR / `use cache` adoption.
- No client-side data fetching rewrite (SWR/React Query) — server
  components + streaming stay the architecture.
- No changes to extract jobs or the data model beyond the optional phase 3
  RPC.
