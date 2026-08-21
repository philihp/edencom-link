# Stage 3: Solutions & Options

**Goal:** Identify concrete optimization strategies ranked by impact and effort.

## Solutions by Category

### A. SDE Mirror Workflow Optimizations

#### A1: Stream ZIP decompression instead of buffering full file

**Impact:** High (30–40% potential memory reduction)  
**Effort:** Medium–High  
**Approach:**

- Use `node:zlib` streaming decompression with chunked reads
- Parse JSONL on-the-fly without buffering entire files
- Reduce intermediate string/object allocations
- Each ingest step processes only its assigned slice cursor-resumably

**Tradeoff:** Adds complexity to workflow orchestration state management; need to validate file integrity per chunk.

#### A2: Deduplicate SDE mirror lane zip handling

**Impact:** Low–Medium (5–10%)  
**Effort:** Low  
**Approach:**

- Share single decompressed stream across lanes instead of decompressing per lane
- Coordinate lane reads at a lower level (file-slice granularity)

**Tradeoff:** Complex synchronization; may not be worth it if lanes already run sequentially within files.

#### A3: Tune ingest batch sizes for DB inserts

**Impact:** Low–Medium (5–10%)  
**Effort:** Low  
**Approach:**

- Experiment with insert batch sizes (currently likely 500–1000)
- Balance memory footprint per batch against query overhead
- Measure INSERT latency at different batch sizes

**Tradeoff:** Marginal gain; might slightly increase query count.

### B. ESI Extract Job Optimizations

#### B1: Stream paginated responses and insert as pages arrive

**Impact:** High (10–20%)  
**Effort:** Medium  
**Approach:**

- Instead of collecting all pages into an array before reconciliation:
  - Fetch page N
  - Upsert rows incrementally (or append to a temp file on disk)
  - Clear page N from memory before fetching page N+1
- Reconciliation: stream old state from DB, stream new state from responses, merge on-the-fly

**Tradeoff:** More DB roundtrips; need streaming reconciliation logic.

#### B2: Pre-allocate and reuse buffers in reconciliation

**Impact:** Medium (8–15%)  
**Effort:** Low–Medium  
**Approach:**

- Reconciliation currently builds `oldMap` and `newMap` objects per job
- Reuse same map structure across batch operations instead of rebuilding per item
- Use typed arrays (Uint32Array, etc.) for numeric data where applicable

**Tradeoff:** Slightly less readable code; type assumptions must be validated.

#### B3: Streaming name resolution

**Impact:** Low–Medium (3–8%)  
**Effort:** Low  
**Approach:**

- Currently collects all unresolved IDs, then batch-resolves
- Stream resolved names to DB as they arrive from ESI instead of buffering
- Resolve in smaller batches (100 IDs vs 1000) if ESI latency permits

**Tradeoff:** More roundtrips; marginal benefit if batch size already near limits.

#### B4: Chunked bulk inserts

**Impact:** Low–Medium (5–10%)  
**Effort:** Low  
**Approach:**

- Insert in chunks of 500–1000 rows instead of one mega-insert
- Reduces peak memory for single `INSERT` planning
- Allows garbage collection between chunks

**Tradeoff:** More queries; slight latency increase; generally safe in Postgres.

### C. SDE Loader & Cache Optimizations

#### C1: Bound SDE loader cache size

**Impact:** Low–Medium (3–8%)  
**Effort:** Low  
**Approach:**

- Cache currently has no upper bound
- Implement LRU eviction at (e.g.) 10,000 entries per cache
- Log cache misses to detect if bound is too aggressive

**Tradeoff:** Potential cache misses on large lookups; worth monitoring.

#### C2: Adjust cache TTL based on hit rate

**Impact:** Low–Medium (2–5%)  
**Effort:** Low  
**Approach:**

- Measure cache hit rate in prod
- If hit rate > 90%, reduce TTL from 6h to 1h (faster data freshness, less memory)
- If hit rate < 50%, investigate why (typos? cold starts?)

**Tradeoff:** Requires monitoring infrastructure.

#### C3: Move cache to external layer (Redis)

**Impact:** Medium (5–15% per function, but shifts memory elsewhere)  
**Effort:** High  
**Approach:**

- Use Supabase Redis or external Redis instance
- Trade in-process memory for network roundtrips
- Enables shared cache across function instances

**Tradeoff:** Network latency per cache hit; external service dependency; cost shift.

### D. API Response & Streaming Optimizations

#### D1: Stream API responses instead of buffering

**Impact:** Medium (5–15%)  
**Effort:** Medium  
**Approach:**

- CSV/JSON endpoints: use `ReadableStream` to write response incrementally
- Avoid building full response array in memory
- Backpressure handling (pause iteration if client is slow)

**Tradeoff:** Response streaming adds framework overhead; error handling mid-stream is tricky.

#### D2: Pagination-first API design for large exports

**Impact:** Low–Medium (3–8%)  
**Effort:** Medium  
**Approach:**

- CSV exports: add limit & offset params instead of exporting all
- Default to 10,000 rows per page
- Client (Google Sheets) makes multiple requests

**Tradeoff:** User UX change; client must handle pagination.

#### D3: Compress large responses (gzip)

**Impact:** Low (2–4%, mostly bandwidth not memory)  
**Effort:** Low  
**Approach:**

- Enable gzip compression on API routes (Next.js built-in)
- Particularly for CSV exports and JSON blobs

**Tradeoff:** CPU overhead; minimal memory benefit.

### E. Database & Connection Pool Tuning

#### E1: Query result streaming from Postgres

**Impact:** Low–Medium (2–5%)  
**Effort:** Medium–High  
**Approach:**

- Use Postgres cursors or streaming protocols to avoid materializing full result sets
- Supabase PostgREST may not support this natively; might need direct `node-postgres`

**Tradeoff:** Architectural change; loses Supabase RLS convenience for some queries.

#### E2: Supabase connection pool tuning

**Impact:** Low (1–3%)  
**Effort:** Low  
**Approach:**

- Review `supabase-js` connection pool settings
- Tune idle timeout and max connections per function

**Tradeoff:** Minimal impact unless pool is misconfigured.

## Solution Prioritization Matrix

```
High Impact + Low Effort (Do First):
- B3: Chunked bulk inserts
- C1: Bound SDE cache
- D1: Stream API responses
- C2: Adjust cache TTL

Medium Impact + Medium Effort (Do Next):
- A1: Stream ZIP decompression
- B1: Stream paginated responses
- B2: Pre-allocate buffers

Low Impact + Low Effort (Polish):
- A3: Tune ingest batch sizes
- B4: Chunked bulk inserts (duplicate of B3)
- D3: Response compression
- E2: Connection pool tuning

High Effort + Low-Medium Impact (Defer):
- C3: External Redis cache
- E1: Postgres cursor streaming
```

---

**Next:** See [Stage 4: Implementation Roadmap](04-implementation-roadmap.md)
