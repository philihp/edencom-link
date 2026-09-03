# PR 1 — `sde_system_jump` view + jump-distance loader

> **Part of this has landed.** The `sde_system_jump` view (migration
> `20260902092205_sde_system_jump.sql`, dual-written into `schema.sql`) and a
> loader `src/sdeJumps.ts` shipped with the data-driven `/mercenary-dens` map.
> The loader exposes only `getSystemJumpGraph()` — the cached adjacency map
> described below — so what is left of this PR is the BFS on top of it
> (`getJumpDistances`/`getJumpDistance`) and its gate checks.

Foundation PR: expose the stargate graph as an app-shaped view and add a
DB-backed loader `src/sdeJumps.ts` that answers "how many jumps from system A
to systems B, C, D…" with an in-process BFS. No UI changes; nothing consumes
it yet (doc 03 does).

## 1. The view (migration + `schema.sql`)

The nightly mirror already lands `sde_map_stargates` (13,978 rows — one per
directed gate; every gate has a paired return gate, so this is the complete
directed edge set). Each row's `data` jsonb carries the edge directly:

```json
{"_key": 50000001, "destination": {"solarSystemID": 30000778, "stargateID": 50000482},
 "position": {...}, "solarSystemID": 30000777, "typeID": 29633}
```

Add an app-shaped projection next to `sde_kspace_system` / `sde_station` /
`sde_planet`, following their exact pattern (see
`supabase/migrations/20260716010000_sde_mirror.sql` and the `sde_*` section
of `schema.sql`):

```sql
-- Ensure the mirror table exists before the view does (a fresh reset runs
-- before the first ingest) — same trick the sde_mirror migration uses for
-- the other app-critical mirror tables.
select public.ensure_sde_mirror_table('map_stargates');

-- Directed system→system stargate edges. Both directions are present because
-- CCP ships every gate with its paired return gate; consumers can treat the
-- row set as a complete directed adjacency list.
create view public.sde_system_jump
with (security_invoker = true) as
select
  (data ->> 'solarSystemID')::bigint as from_system_id,
  (data -> 'destination' ->> 'solarSystemID')::bigint as to_system_id
from public.sde_map_stargates;

grant select on public.sde_system_jump to anon, authenticated, service_role;
revoke insert, update, delete on public.sde_system_jump from anon, authenticated;
```

Dual-write: add the incremental migration (`pnpm run db:new
sde_system_jump`) **and** put the same statements into `schema.sql` alongside
the other `sde_*` views (the `ensure_sde_mirror_table('map_stargates')`
pre-create goes next to the existing
`select public.ensure_sde_mirror_table(stem) from unnest(...)` call — just
add `map_stargates` to that array in `schema.sql`; the migration calls it
directly). No RLS work: the view is `security_invoker` over a mirror table
that already has the anyone-reads policy.

No materialized view needed — the view is a two-field jsonb projection the
loader reads a handful of times per process lifetime.

## 2. The loader — `src/sdeJumps.ts`

New async loader following the `src/sde*.ts` house pattern (header comment,
`sdeSupabase()` client from `src/utils/supabase/sde.ts`, errors logged and
degraded rather than thrown). It differs from the by-id loaders in one way:
the unit of caching is the **whole graph**, not individual rows, so it does
not use `createByIdCache` — it keeps a module-level cached promise with the
same 6h TTL (`src/sdeCache.ts` uses `TTL_MS = 6 * 60 * 60 * 1000`; either
export that constant from `sdeCache.ts` or restate it locally with a comment
pointing there).

### Fetching the graph

Page through the view with the tail-recursive range-paging shape from
CLAUDE.md (14 pages of 1000 at today's row count):

```ts
type Edge = { from_system_id: number; to_system_id: number }

const PAGE_SIZE = 1000

const readEdges = async (from = 0, acc: Edge[] = []): Promise<Edge[]> => {
  const { data, error } = await sdeSupabase()
    .from('sde_system_jump')
    .select('from_system_id, to_system_id')
    .order('from_system_id')
    .order('to_system_id')
    .range(from, from + PAGE_SIZE - 1)
  if (error) throw new Error(`reading sde_system_jump failed: ${error.message}`)
  forEach((row) => acc.push(row as Edge), data ?? []) // ramda forEach, push-mutated accumulator
  return (data ?? []).length < PAGE_SIZE ? acc : readEdges(from + PAGE_SIZE, acc)
}
```

Build `Map<number, number[]>` adjacency from the edges. Cache the built
adjacency (not the raw rows) with the fetch timestamp; on any fetch error,
log and return an **empty** graph without caching it — mirroring the
"misses are never cached" rule, so a fresh deploy before the first ingest
(empty table) or a DB hiccup degrades to "no distances known" and heals on
the next call. Guard against concurrent warm-ups by caching the in-flight
promise, but clear it on rejection.

### BFS

```ts
// jumps from origin to each target, by shortest stargate path; null when
// unreachable (wormholes, abyssal systems, Pochven-style disconnected
// pockets, or an origin/target with no gates).
export const getJumpDistances = async (
  originSystemID: number,
  targetSystemIDs: Iterable<number>
): Promise<Record<number, number | null>>

export const getJumpDistance = async (from: number, to: number): Promise<number | null>
```

Plain breadth-first search from the origin over the adjacency map, written as
a tail-recursive frontier walk (no `while`): recurse on the next frontier
while it's non-empty **and** targets remain unfound — early exit once every
requested target has a distance. Fill unreached targets with `null`.
Measured worst case (all targets unreachable → full traversal of 5,268
systems) is ~8 ms; typical asset pages ask for a few dozen targets within
~15 jumps and exit in well under that. Don't memoize per-origin BFS results
— the traversal is cheaper than the bookkeeping.

The origin itself is distance 0; an origin absent from the graph (docked in
a wormhole, say) yields `null` for everything, which doc 03 renders as
"no sort available", not an error.

## Gates

- `pnpm run lint` and `pnpm run build` pass.
- Migration applies cleanly (`pnpm run db:push` on the linked project, or
  let the `Migrate` workflow do it on merge).
- Manual check in a dev console / scratch route: `getJumpDistance(30000142,
30002187)` (Jita→Amarr) returns **11**, `getJumpDistance(30000142,
30000142)` returns **0**, and a wormhole system id (e.g. 31000005) returns
  **null**. These values were validated against SDE build 3442663.
