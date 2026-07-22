# Stage 4: Implementation Roadmap

**Goal:** Prioritize and schedule memory optimization work with concrete deliverables.

## Phase 1: High-Impact Quick Wins (Weeks 1–2)

Target: 15–25% memory reduction with low-risk changes.

### Task P1.1: Chunked bulk inserts across all extract jobs
**Files affected:** `src/jobs/*.js` (asset, blueprint, order, job, etc.)  
**Effort:** 2–3 days  
**Expected impact:** 5–10% memory reduction

**Scope:**
- Identify all places currently building full `INSERT` payloads before sending to DB
- Refactor to chunk into 500–1000 row batches
- Preserve transaction semantics (wrap batch in same TX if needed)
- Test with a large character asset export

**Acceptance criteria:**
- [ ] All extract jobs chunk inserts
- [ ] No performance regression (latency ≤ 5% increase)
- [ ] Batch sizes configurable via env var

---

### Task P1.2: Bound SDE loader cache
**Files affected:** `src/sdeCache.ts`, `src/sde*.ts`  
**Effort:** 1 day  
**Expected impact:** 3–8% memory reduction

**Scope:**
- Implement LRU cache wrapper around existing caches
- Limit to 10,000 entries per cache type (experiment with size)
- Log evictions and hit rate to observability
- Benchmark before/after on a prod-like function

**Acceptance criteria:**
- [ ] Cache bounded to configurable max size
- [ ] Eviction metrics logged
- [ ] Hit rate > 90% with new bound
- [ ] No new DB queries on cache eviction

---

### Task P1.3: Stream API responses (CSV / JSON exports)
**Files affected:** `src/app/api/character/assets/route.ts`, `/blueprints/route.ts`, `/corp/**/route.ts`  
**Effort:** 2–3 days  
**Expected impact:** 5–15% memory reduction

**Scope:**
- Refactor CSV export routes to stream response incrementally
- Use `ReadableStream` or `Response.bodyUsed` pattern
- Avoid building full result array before sending
- Test with largest asset hangar (measure response time, memory peak)

**Acceptance criteria:**
- [ ] All CSV/JSON export routes stream instead of buffer
- [ ] Response time ≤ 10% increase for large exports
- [ ] Memory peak reduced by measured amount
- [ ] No breaking changes to client (Google Sheets) usage

---

### Task P1.4: Adjust SDE cache TTL based on metrics
**Files affected:** `src/sdeCache.ts`  
**Effort:** 1 day  
**Expected impact:** 2–5% memory reduction

**Scope:**
- Log cache hit rate per cache type
- If hit rate > 90%, reduce TTL from 6h to 2h
- Publish metrics to observability dashboard
- Monitor for data staleness issues

**Acceptance criteria:**
- [ ] Cache hit rate logged and dashboarded
- [ ] TTL adjusted based on data
- [ ] No staleness complaints in 1 week

---

## Phase 2: Medium-Impact Stream Rewrites (Weeks 3–5)

Target: 10–20% additional memory reduction (25–40% cumulative).

### Task P2.1: Stream SDE mirror ZIP decompression
**Files affected:** `src/jobs/sdeMirror.js`, `src/workflows/sdeMirror.ts`  
**Effort:** 4–5 days  
**Expected impact:** 20–30% memory reduction (for this job specifically; ~5–10% overall if SDE mirror is 20% of total memory)

**Scope:**
- Replace full ZIP buffer with streaming decompression
- Parse JSONL on-the-fly without buffering entire files
- Update workflow step persistence to track cursor position per file/lane
- Validate data integrity per chunk (checksums or by other means)
- Test on full SDE mirror run

**Acceptance criteria:**
- [ ] ZIP never fully decompressed to memory
- [ ] JSONL parsing streaming (not buffering full file)
- [ ] Workflow state persists cursor position correctly
- [ ] Full SDE mirror completes in ≤ 15 min (no perf regression)
- [ ] Data integrity matches original (row counts, checksums)

---

### Task P2.2: Stream ESI paginated responses with incremental insert
**Files affected:** `src/jobs/characterAssets.js`, `src/jobs/characterBlueprints.js`, `src/jobs/corpAssets.js`, `src/jobs/corpBlueprints.js`  
**Effort:** 4–6 days  
**Expected impact:** 10–15% memory reduction

**Scope:**
- Refactor largest jobs (assets, blueprints) to insert each page as it arrives
- Streaming reconciliation: merge old/new state without buffering full maps
- For assets: process location-by-location instead of all assets at once
- Validate reconciliation logic produces identical results as before
- Start with `characterAssets`, replicate pattern to others

**Acceptance criteria:**
- [ ] Pages inserted incrementally (no full buffer in memory)
- [ ] Reconciliation results identical to original (spot-check 10 random characters)
- [ ] Memory peak reduced by measured amount
- [ ] Job latency ≤ 5% increase
- [ ] No race conditions (cursors + pagination)

---

### Task P2.3: Pre-allocate and reuse reconciliation buffers
**Files affected:** `src/jobs/lib.js`, per-job reconciliation logic  
**Effort:** 2–3 days  
**Expected impact:** 8–15% memory reduction

**Scope:**
- Profile reconciliation hot spots with `--inspect`
- Identify where full maps are rebuilt per iteration
- Implement buffer reuse pattern (object pooling)
- Use typed arrays for numeric data where applicable
- Benchmark allocation/deallocation patterns

**Acceptance criteria:**
- [ ] Fewer object allocations in reconciliation (measured via heap snapshots)
- [ ] Memory peak reduced by measured amount
- [ ] Results identical (no mutation bugs)

---

## Phase 3: Observability & Tuning (Weeks 6–8)

Target: Establish monitoring to sustain and validate gains.

### Task P3.1: Memory profiling dashboard
**Files affected:** `src/observability.js`, Vercel Observability config  
**Effort:** 2–3 days  
**Expected impact:** Enables future optimizations

**Scope:**
- Capture per-job memory peak, average, duration
- Track memory trends over time (rolling 30-day view)
- Correlate memory usage with function invocation count and data size
- Surface alerts if memory usage regresses

**Acceptance criteria:**
- [ ] Vercel Observability dashboard with memory metrics per job
- [ ] Alert triggered if job memory exceeds baseline by 10%
- [ ] Daily digest of memory savings vs baseline

---

### Task P3.2: Batch size tuning & experiment
**Files affected:** Extract jobs, API routes  
**Effort:** 2 days  
**Expected impact:** 2–5% further optimization

**Scope:**
- A/B test batch sizes (250 vs 500 vs 1000 rows per batch)
- Measure memory, latency, and throughput
- Set optimal sizes based on data
- Document in CLAUDE.md

**Acceptance criteria:**
- [ ] Batch size impact measured for top 3 jobs
- [ ] Optimal size determined and set
- [ ] No performance regression

---

## Phase 4: Polish & Defer (Post-Phase 3)

### Not planned for this cycle:
- C3: External Redis cache (defer unless memory still critical)
- E1: Postgres cursor streaming (defer, high effort)
- D2: Pagination-first API design (consider if memory still tight)

## Rollout & Validation

### Pre-Deploy Checklist
- [ ] All changes tested locally and on staging
- [ ] Memory profiles captured before/after for each task
- [ ] No breaking changes to API contracts
- [ ] Observability metrics wired up

### Post-Deploy Monitoring (First 7 days)
- [ ] Monitor for data inconsistencies or missing rows
- [ ] Check cache hit rates (should stay >90%)
- [ ] Validate CSV exports still work via Google Sheets
- [ ] Confirm memory trend is downward

### Regression Plan
- [ ] If memory doesn't drop as expected, roll back Phase 2 changes first
- [ ] Investigate why (data size grown? workload changed?)
- [ ] Consider re-profiling after 2 weeks of data

## Cost Impact Projection

Assuming memory is currently ~$X/month:

- **Phase 1:** 15–25% reduction → ~$0.15–0.25X savings
- **Phase 2:** +10–20% reduction → ~$0.25–0.45X savings cumulative
- **Phase 3:** +2–5% reduction → ~$0.27–0.50X savings cumulative

**Total estimated savings:** 25–50% of current memory cost (~$0.25–0.50X/month), depending on profiling results and unforeseen issues.

---
**Next:** See [Stage 5: Monitoring & Validation](05-monitoring-validation.md)
