# Stage 2: Root Cause Analysis

**Goal:** Identify where memory is being consumed and why.

## Known Memory Pressure Points

### 1. SDE Mirror Workflow

**Location:** `src/workflows/sdeMirror.ts` + `src/jobs/sdeMirror.js`

**Current behavior:**

- Downloads full CCP SDE zip (estimated ~100-200 MB compressed)
- Decompresses in memory (`node:zlib`)
- Ingests each JSONL file row-by-row, building up accumulated changes
- Stores in-memory state across multiple ingest steps (cursor tracking, lane state)
- Multiple concurrent lanes reading the same immutable zip (decompressed per lane?)

**Known inefficiencies:**

- [ ] Zip decompressed fully to memory rather than streamed?
- [ ] Accumulators rebuilt on every row (`[...acc, x]` instead of `.push()`)?
- [ ] Intermediate objects/strings not garbage collected between steps?
- [ ] Lane state accumulating across retries?

### 2. ESI Extract Jobs

**Locations:** `src/jobs/character*.js`, `src/jobs/corp*.js`, `src/jobs/industry*.js`, etc.

**Current behavior:**

- Paginated API responses collected into memory before bulk insert
- Asset reconciliation (SCD-2) builds full in-memory maps of old/new state
- Name resolution collects all unresolved IDs before batch lookup
- Each job loops through potentially thousands of items

**Known inefficiencies:**

- [ ] Responses held in memory before DB insert (pagination could chunk inserts)
- [ ] No streaming response handling (each page buffered)
- [ ] Reconciliation algorithms building full copies of data structures
- [ ] No backpressure mechanism if a page is particularly large

### 3. SDE Loaders & Caching

**Locations:** `src/sdeTypes.ts`, `src/sdeSystems.ts`, `src/sdeStations.ts`, `src/sdePlanets.ts`, `src/sdeBlueprints.ts`

**Current behavior:**

- Process-level cache with 6h TTL (shared across all requests in a function)
- Cache keyed by type ID / system ID / etc.
- Miss entries are never cached (prevents unbounded cache on typos)
- Hit rates TBD

**Known inefficiencies:**

- [ ] Cache size limits? Could cache grow unbounded if many unique IDs requested?
- [ ] Cold start for each new function invocation (no cross-invocation cache)
- [ ] 6h TTL might be too long (stale data) or too short (cache misses cause DB hits)
- [ ] Cache entry serialization/cloning overhead?

### 4. Request/Response Handling

**Locations:** `src/app/api/*` routes, MCP server (`src/app/api/mcp/route.ts`)

**Current behavior:**

- Full results collected in memory before response serialization
- CSV exports (`src/utils/csv.ts`) build full string before sending
- MCP tool responses serialize all data before streaming

**Known inefficiencies:**

- [ ] No streaming responses (Next.js Readable streams available)
- [ ] Large asset/blueprint lists held in memory until serialized
- [ ] CSV formatting done string-by-string instead of streaming

### 5. Database Connection Pooling & Queries

**Locations:** `src/supabase.js`, `src/utils/supabase/*`

**Current behavior:**

- Service-role and anon clients shared at module level
- Bulk queries return full result sets
- No pagination on RPC/function results

**Known inefficiencies:**

- [ ] PostgREST default limit is 1000 rows (mitigated by range paging in some routes)
- [ ] Large SELECT queries collect entire result before returning to application
- [ ] Connection pool size and idle timeout tuning unknown

## Hypothesis Ranking (by estimated impact on memory)

| Rank | Issue                                                   | Estimated Impact | Effort     | Confidence |
| ---- | ------------------------------------------------------- | ---------------- | ---------- | ---------- |
| 1    | SDE mirror zip decompression + ingest                   | 30–50%           | Medium     | High       |
| 2    | ESI asset/blueprint reconciliation builds full maps     | 15–25%           | Medium     | High       |
| 3    | Extract jobs buffer full paginated responses            | 10–20%           | Low        | High       |
| 4    | SDE loader cache unbounded growth or inefficient lookup | 5–10%            | Low–Medium | Medium     |
| 5    | API responses collected in memory before streaming      | 5–15%            | Low        | High       |
| 6    | Multiple SDE mirror lanes decompressing same zip        | 5–10%            | Low        | Medium     |

## Investigation Tasks

- [ ] Profile `sdeMirror` step with `--inspect` to check heap usage
- [ ] Log memory before/after each ingest lane task
- [ ] Profile a large asset reconciliation (`characterAssets.js`)
- [ ] Query Vercel Observability for memory trend over past 30 days
- [ ] Measure SDE loader cache hit rate on prod
- [ ] Review Supabase connection pool settings
- [ ] Test CSV export with large asset list (measure memory delta)

## Assumptions

- Memory cost scales with function invocation count and peak memory duration
- Reducing peak memory per invocation is more impactful than reducing average
- Streaming responses are viable for most API endpoints (not real-time subscriptions)
- Batch size tuning (chunk inserts at 500 vs 1000) has meaningful impact

---

**Next:** See [Stage 3: Solutions](03-solutions.md)
