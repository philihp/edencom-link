# PR 3 — proximity sort on `/asset`

Wire docs 01 + 02 together: the Assets page computes the jump distance from
the main character's current system to every system it lists, and the table
gains a "Nearby" sort that puts the closest systems first. Depends on PR 1
(`getJumpDistances`) and benefits from PR 2 (fresh `character_location`);
it works without PR 2, just with staler positions.

## 1. Origin helper — `src/app/mainLocation.ts`

Small server helper answering "which system is this account's main character
in right now", shaped like `src/app/owners.ts` (accepts an optional Supabase
client so the MCP tools can reuse it later with a bearer-token client):

```ts
export type MainLocation = {
  characterId: string // registration uuid
  characterName: string
  solarSystemID: number
  recordedAt: string
}

export const fetchMainLocation = async (client?: SupabaseClient): Promise<MainLocation | null>
```

Implementation: two RLS-scoped queries —
`registration.select('id, name, is_main')` and
`character_location.select('character_id, solar_system_id, recorded_at')`
(the existing "Users read own location" policy already scopes this to the
caller's registrations). Pick the location row belonging to the `is_main`
registration; when the main has no location row (its token lacks
`esi-location.read_location.v1`, or no extract has run yet), fall back to
the user's **most recently recorded** location row; return `null` when there
are none at all. `is_main` is auto-assigned to the account's oldest
character on first link (`src/app/character/callback/route.ts`) and
re-pickable at `/account/settings`, so the fallback is a corner case, not
the norm.

## 2. Server side — `src/app/asset/page.tsx`

The `Locations` component already resolves every root location and
`resolveLocations` (`src/app/resolveLocations.ts`) already exposes
`systemIdFor` — today the page only uses `nameFor`/`systemFor`:

```ts
const { nameFor, systemFor } = await resolveLocations(map(({ root }) => root, [...byLocation.values()]))
```

Changes:

- Also destructure `systemIdFor`.
- Fetch the origin: `const origin = await fetchMainLocation()` — add it to
  the existing `Promise.all` batch alongside the summaries/owners/heartbeat
  fetches (it's independent of them).
- Collect each location's `systemIdFor(root)` and call
  `getJumpDistances(origin.solarSystemID, systemIds)` from `src/sdeJumps.ts`
  (skip entirely when `origin` is `null`).
- Extend the `Location` shape passed to the client with the distance, and
  pass the origin for display:

```ts
export type Location = {
  id: string
  name: string
  system: string | null
  jumps: number | null // stargate jumps from the main's current system; null = unknown/unreachable
  counts: Record<string, number>
}
```

`jumps` is `null` when the origin is unknown, the location has no resolvable
system (unresolved structure), or BFS can't reach it (wormhole/Pochven/
abyssal). One BFS answers every location on the page (~8 ms worst case,
in-process — see docs/asset-proximity/README.md), so this adds no measurable
server time to a page that already walks hangars in Postgres.

Pass `originSystem: string | null` (the origin system's _name_, resolved via
`getSdeSystemNames` or the page's existing name plumbing) and
`originCharacter: string | null` into `AssetsTable` so the sort control can
say what it's measuring from.

## 3. Client side — `src/app/asset/assetsTable.tsx`

Today the table groups locations by system and sorts groups busiest-first
(`b.total - a.total || a.system.localeCompare(b.system)`). Add a sort mode:

- **`activity`** (default, unchanged): busiest system first.
- **`nearby`**: fewest jumps first; `null` jumps sort last; ties broken by
  the existing busiest-first ordering. Every location in a group shares its
  system, so a group's distance is the first non-null `jumps` among its
  rows.

UI:

- A second control in the header next to the owner filter:
  `Sort: [Activity | Nearby]` (a `<select>` matching the `OwnerSelect`
  styling). Persist the choice in `localStorage` the same way the owner
  filter does (`OWNER_STORAGE_KEY` lives in `src/app/asset/filterKey.ts`;
  add `SORT_STORAGE_KEY` beside it, with the same read-after-mount hydration
  pattern `useOwnerFilter` uses so SSR output stays deterministic).
- When `nearby` is active, show the distance on each system's header row,
  e.g. `Uemon · 4 jumps` (`0 jumps` for the origin system itself, `—` for
  unreachable), and a caption under the header:
  `Distances from <originSystem> (<originCharacter>)`.
- When no origin exists (`originSystem === null`) or every `jumps` is
  `null`, render the sort control disabled with a title explaining why
  ("No recent location for your characters — link a character with the
  esi-location.read_location.v1 scope"). Don't hide it; discoverability is
  the point.
- Changing sort mode resets to page 1, same as changing owner does today.

Sorting stays entirely client-side over data already in memory — same reason
owner switching is instant.

## Gates

- `pnpm run lint` and `pnpm run build` pass.
- Manual checks on `/asset`:
  - Activity sort renders exactly as before (default unchanged).
  - Nearby sort puts the main's current system first with `0 jumps`;
    known distances spot-checked against the in-game route planner
    (remember in-game "shortest" must be selected — this sort is
    security-agnostic shortest-path).
  - Wormhole/unreachable systems group at the bottom under `—`.
  - An account with no location rows sees the disabled control, not a crash.
  - Owner filter + sort mode compose (switching either keeps the other).
