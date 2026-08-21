# Asset proximity: sort the Assets page by jumps from your main

Sort the systems on `/asset` by how many stargate jumps they are from wherever
the account's main character currently is, so the stuff you can actually go
get sits at the top. Three deliverables, shipped as **separate PRs, in
order** — each numbered document is a self-contained implementation spec:

| Doc                                            | PR     | What                                                                                                                | Status / dependency   |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| [01-jump-graph.md](01-jump-graph.md)           | small  | `sde_system_jump` view over the mirrored stargate data + `src/sdeJumps.ts` loader with a BFS jump-distance function | Independent; do first |
| [02-hourly-location.md](02-hourly-location.md) | tiny   | Schedule the existing `character-location` extract hourly via Vercel Cron                                           | Independent of 01     |
| [03-assets-sort.md](03-assets-sort.md)         | medium | `/asset` computes jumps from the main character's current system and gains a "Nearby" sort                          | After 01 **and** 02   |

Future ideas deliberately **not** in scope (park them unless asked): a
`character_location_over_time` history table (where does my main actually
hang out?), proximity in `/asset/search` results and the `search_assets` MCP
tool, security-aware routing preferences (shortest vs. high-sec-only — this
plan is plain shortest-path), Thera/Turnur wormhole shortcuts, and showing
jump distance on `/structure` or `/mercenary-dens`.

## Feasibility (validated 2026-07-23 against SDE build 3442663)

The question was whether the SDE carries a **precalculated** distance
function. It doesn't — the legacy `mapSolarSystemJumps` /
`mapRegionJumps` tables from the old community SQL conversions did not
survive into CCP's JSONL export, and no all-pairs distance file exists. What
the export _does_ carry is the full stargate graph, and that turns out to be
all we need:

- **`mapStargates.jsonl`** → already mirrored nightly as
  **`sde_map_stargates`** (13,978 rows; the mirror ingests every JSONL file
  in the export, so this table exists in production today — no ingest change
  needed). Each row is one directed gate and carries the system→system edge
  directly, no gate-id join required:

  ```json
  {"_key": 50000001,
   "destination": {"solarSystemID": 30000778, "stargateID": 50000482},
   "position": {...}, "solarSystemID": 30000777, "typeID": 29633}
  ```

  Every gate has a paired return gate, so the 13,978 rows are the complete
  directed edge set (~2.65 edges/system average).

- **`mapSolarSystems.jsonl`** (`sde_map_solar_systems`, 8,490 rows) also
  carries `position` (x/y/z meters) per system — usable for light-year
  distances later, but jumps are what a hauler cares about.

- **BFS over the whole graph is trivially cheap.** Measured in Node on the
  real data: 5,268 systems have gates; a full breadth-first traversal from
  Jita (30000142) reaches 5,228 systems in **8 ms**, max depth 57. Sanity
  checks: Jita→Amarr = 11 jumps, Jita→Dodixie = 12 (both correct
  post-Pochven shortest routes). The 40 gated-but-unreached systems are the
  Pochven/Zarzakh style disconnected pockets; wormhole and abyssal systems
  have no gates at all. Those come back "unreachable" and sort last, which
  is the right answer.

### Where the computation lives (decision)

**In the Node process, as an `src/sde*.ts` loader** (doc 01), not in
Postgres and not precomputed:

- A Postgres recursive-CTE BFS is awkward (recursive CTEs can't dedup the
  visited set across iterations without carrying arrays) and slower than
  8 ms of in-process work.
- A precomputed all-pairs table is 5,268² ≈ 27.7M rows to answer a question
  one page asks about ~a few dozen systems.
- The graph is ~14k tiny rows: one paged fetch through PostgREST
  (14 requests of 1000), cached per server process for 6h exactly like the
  other SDE loaders (`src/sdeCache.ts` TTL). After warm-up a request costs
  one in-memory BFS.

### Freshness of "where is the main" (decision)

`character_location` already exists (single upserted row per character,
written by the `character-location` job / the 6-hourly `character-status`
combo job). ESI's `/characters/{id}/location/` is one of the cheapest
authed endpoints there is (tiny JSON, 5s server-side cache), so doc 02 just
puts the **existing** `character-location` job on an hourly Vercel Cron
fan-out — no new job module, no new table, no schema change. The
main-character designation also already exists: `registration.is_main`
(picker at `/account/settings`, auto-assigned to the oldest character by
`src/app/character/callback/route.ts`).

## House rules (from CLAUDE.md — these bite)

- **No test runner.** Gates are `pnpm run lint` + `pnpm run build`, plus
  manually exercising the touched pages. Every PR passes both.
- **Schema changes are dual-write:** edit `schema.sql` (full-reset source of
  truth) **and** add an incremental migration under `supabase/migrations/`
  (`pnpm run db:new <name>`); **never rename an existing migration file.**
- **Ramda over `for`/`while`** for synchronous iteration; unbounded paging
  loops are tail-recursive async functions (see the `readMirror` shape in
  CLAUDE.md). A BFS frontier loop is the same shape: recurse on the next
  frontier while it's non-empty.
- **Server components never call ESI.** All ESI traffic stays in the extract
  jobs; the UI reads the DB and the `sde_*` mirror.
- **Never** use Fuzzwork's third-party SDE mirror for anything.
- **`git fetch origin && git rebase origin/main`** immediately before
  pushing and opening each PR. No exceptions.
- Line numbers quoted in these docs will drift — anchor on the quoted code,
  not the numbers, and re-verify each call site before editing.
