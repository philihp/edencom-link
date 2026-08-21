# Stage 1: Discovery & Current State Assessment

**Goal:** Establish baseline memory usage metrics and costs to understand the scope of the problem.

## Current State

### Memory Usage Overview

- **Primary concern:** Fluid compute memory consumption is the largest recurring expense
- **Data source:** TBD — Vercel billing, observability dashboard, application metrics
- **Baseline measurement date:** [TO BE FILLED]

### Memory Allocation by Function/Service

```
[Document the breakdown of memory usage by:]
- Vercel functions by endpoint / job
- SDE mirror operations (most memory-intensive?)
- ESI extract jobs (assets, blueprints, industry jobs, etc.)
- Request/response handling
- Database connection pooling
- Cache layers (SDE cache, process-level caching)
- Other services
```

### Cost Analysis

```
Monthly memory cost breakdown:
- Total: $[X]
- Cost per MB/hour: $[Y]
- Top 5 memory consumers by cost: [LIST]
```

### Current Architecture Context

- **Stack:** Next.js 16 + Node 24, ESM
- **Key memory users:**
  - SDE mirror workflow (reads full zip, ingests tables)
  - ESI extract jobs (paginated API responses, reconciliation)
  - SDE loaders (`src/sde*.ts`) with process-level caching (6h TTL)
  - Supabase client connections
  - Ship-fitting protobuf encoding (`encodeEsfData()`)

### Profiling & Instrumentation

**Current visibility:**

- [ ] Vercel function memory metrics available?
- [ ] Application performance monitoring (APM) enabled?
- [ ] Heap snapshots or profiling data captured?

**To acquire:**

- [ ] Capture baseline memory profiles for top 3 jobs (with `node --inspect` or similar)
- [ ] Export Vercel observability data for past 30 days
- [ ] Identify peak memory usage patterns (time of day, day of week, per job)

## Deliverables for Next Stage

- **Memory baseline snapshot** — current peak/average per function type
- **Cost impact analysis** — total annual spend on memory, relative to total infrastructure cost
- **Instrumentation plan** — how to continuously measure progress

## Notes & Assumptions

- Assume memory spikes correlate with SDE mirror workflow (largest data ingest)
- Assume process-level SDE cache (6h TTL) is beneficial but may not be optimal
- Assume extract jobs handle large paginated responses inefficiently (no streaming)

---

**Next:** See [Stage 2: Analysis](02-analysis.md)
