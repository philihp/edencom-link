# Fluid Compute Memory Optimization Project

> **Closed 2026-08-12 — the goal was met, the plan below was not the thing that
> met it.** Read [Outcome](#outcome) first; the staged plan is kept as-is for
> the analysis in stages 2–3, not as a live work queue.

**Objective:** Reduce memory consumption of Vercel Fluid Compute functions to lower our largest recurring expense.

## Overview

This project folder contains a multi-stage plan to identify and eliminate unnecessary memory usage across the edencom-link application, focusing on ESI extract jobs, SDE mirror workflow, API responses, and database operations.

**Target:** 25–50% memory cost reduction over 8 weeks.

---

## Stages

Each stage builds on the previous one and includes concrete deliverables and acceptance criteria.

### [Stage 1: Discovery & Current State Assessment](01-discovery.md)
**Goal:** Establish baseline memory metrics and costs.

- [ ] Measure current memory usage per function type
- [ ] Quantify cost impact (total monthly spend on memory)
- [ ] Identify top 3 memory consumers
- [ ] Acquire profiling data (heap snapshots, observability logs)

**Duration:** 3–5 days  
**Output:** Baseline snapshot document

---

### [Stage 2: Root Cause Analysis](02-analysis.md)
**Goal:** Identify why memory is being consumed and where.

- [ ] Profile SDE mirror workflow (largest data ingest)
- [ ] Analyze ESI extract job reconciliation (assets, blueprints)
- [ ] Examine SDE loader cache behavior
- [ ] Review API response buffering patterns
- [ ] Hypothesis ranking by impact vs. effort

**Duration:** 3–5 days  
**Output:** Root cause document with prioritized solutions

---

### [Stage 3: Solutions & Options](03-solutions.md)
**Goal:** Identify concrete optimization strategies.

Organized by category:
- **A. SDE Mirror Workflow** (30–50% potential savings)
- **B. ESI Extract Jobs** (10–20% potential savings)
- **C. SDE Loaders & Caching** (5–10% potential savings)
- **D. API Response Streaming** (5–15% potential savings)
- **E. Database Tuning** (1–3% potential savings)

**Output:** Solutions ranked by impact/effort matrix

---

### [Stage 4: Implementation Roadmap](04-implementation-roadmap.md)
**Goal:** Prioritize and schedule concrete work.

**Phase 1: Quick Wins (Weeks 1–2)** — 15–25% reduction
- Chunked bulk inserts across extract jobs
- Bound SDE loader cache
- Stream API responses
- Cache TTL tuning

**Phase 2: Stream Rewrites (Weeks 3–5)** — +10–20% reduction
- Stream SDE mirror ZIP decompression
- Stream ESI paginated responses
- Pre-allocate reconciliation buffers

**Phase 3: Observability (Weeks 6–8)** — +2–5% reduction + monitoring
- Memory profiling dashboard
- Batch size tuning & experiments

**Phase 4: Deferred** — High effort, deferred unless critical
- External Redis cache
- Postgres cursor streaming

**Output:** Task breakdown with effort estimates and acceptance criteria per task

---

### [Stage 5: Monitoring & Validation](05-monitoring-validation.md)
**Goal:** Establish metrics and validation checkpoints.

- Baseline metrics table (memory per job type)
- KPIs to track (cost, avg/p95/p99 memory, data quality)
- Observability implementation (metrics to emit, dashboard setup)
- Validation checkpoints (post-Phase 1, 2, 3)
- Regression testing strategy
- Long-term monitoring plan
- Alerting rules

**Output:** Validation framework and observability setup

---

## How to Use This Project

1. **Start here:** Read [Stage 1](01-discovery.md) and populate the baseline metrics.
2. **Understand the problem:** Complete [Stage 2](02-analysis.md) via profiling & investigation.
3. **Explore options:** Review the [Stage 3](03-solutions.md) solutions and discuss priorities.
4. **Execute:** Work through [Stage 4](04-implementation-roadmap.md) phases in order.
5. **Validate:** Use [Stage 5](05-monitoring-validation.md) checkpoints and dashboards to confirm success.

## Key Assumptions

- Memory cost scales linearly with peak memory usage and invocation frequency
- Reducing peak memory per invocation has the highest ROI
- Streaming and chunked processing are viable for most workloads
- Data consistency (no row loss/duplication) is non-negotiable
- Performance degradation of ≤10% is acceptable if memory savings ≥25%

## Success Criteria (Overall)

- [ ] Memory cost reduced by 25–50% vs baseline (estimated $[X]–[Y] monthly savings)
- [ ] No data inconsistencies or missing rows detected
- [ ] Extract job latency increase ≤ 10%
- [ ] Cache hit rates sustained ≥ 90%
- [ ] Observability dashboard operational
- [ ] All changes documented in CLAUDE.md

## Outcome

The project shipped its win out of order and then stopped, which is the right
outcome — recorded here so nobody re-opens it expecting stages 1–5 to run.

**What happened, in order:**

1. **#676 (2026-07-21) removed the `memory` settings from `vercel.json`** — one
   day *before* this plan merged. Under active-CPU billing Vercel sizes memory
   from real usage, so the lever this whole plan aims at ("lower peak RSS, then
   lower the configured limit, then pay less") no longer exists. `vercel.json`
   still carries no `memory` key today. The stage 1 premise — memory as the
   largest recurring expense — was already stale on arrival.
2. **#687 (2026-07-22) merged this plan** (stages 1–5, all boxes unchecked).
3. **#695 (2026-07-23) did the engineering anyway, on its own terms**, because
   peak RSS is still worth cutting for headroom and for not OOMing a step:
   - **Streamed the SDE ingest** (`src/jobs/sdeMirror.js`): the entry's Range
     fetch pipes through `createInflateRaw` and lines are walked per chunk
     rather than Range-reading and `inflateRawSync`-ing the entry whole.
     Measured on `mapMoons.jsonl` (224 MB inflated): **587 MB → 191 MB peak
     RSS**, ~100 MB of which is baseline Node + modules. The peak no longer
     scales with entry size. This is roadmap task P2.1, delivered.
   - **Compacted the asset reconciles** (`characterAssets.js`, `corpAssets.js`):
     `fetchCurrentByItem` folds each PostgREST page into `item_id → { id, sig }`
     and discards it, instead of accumulating every open row's full columns.
     Peak went from ~3–4× the asset set to ~1×. Partially covers P2.2/P2.3.
   - **Sequenced `encodeEsfData`** (`src/buildEsfData.js`): the six protobuf maps
     build sequentially, largest-first, each released after its encode.
   - **Added `recordPeakRss`** (`src/observability.js`) emitting `job.peak_rss`
     on the same stdout-JSON convention as `esi.conditional_request`. Part of P3.1.

**Net:** the plan's two headline targets (SDE mirror 30–50%, extract jobs 10–20%)
are the ones that got done. Everything left is small, and its payoff is headroom
rather than money.

**Deliberately not done, and why:**

| Task | Why it stays undone |
|---|---|
| P1.1 chunked bulk inserts | Already true before the plan — every extract job upserts via `splitEvery` (500–1000 rows). Nothing to do |
| P1.2 bound the SDE loader cache | `src/sdeCache.ts` is still an unbounded `Map` with a 6h TTL. Bounded by the SDE's own size (types/systems/stations), not by traffic, so it plateaus rather than grows |
| P1.3 stream CSV responses | `/api/{character,corp}/*` still buffer via `toCsv`. Per-request, small next to a mirror ingest |
| P1.4 TTL tuning | Needs the hit-rate metric that P1.2 would add. Not worth it on its own |
| P3.1 dashboard + alerts | The metric is emitted; no dashboard or alert rule was built on it |
| P3.2 batch-size A/B | Speculative without a cost signal to optimize against |
| Phase 4 (Redis, PG cursors) | Was already deferred |

**Known gaps in the instrumentation**, if this is ever picked back up:

- `recordPeakRss` fires from `runJobWithHeartbeat` (`src/workflows/lib.ts`), which
  only wraps the **single-step** jobs, plus per-entry from the sde-mirror ingest.
  The per-character and per-corp fan-out workflows keep their heartbeats inside
  the job modules, so they emit no `job.peak_rss` — the asset jobs #695 optimized
  are exactly the ones not reporting.
- #695 also called it from the innomin.at queue consumer; that call is gone from
  `src/app/api/queue/innominate/route.ts` today (lost when the route moved to
  `handleCallback`).

## Related Documentation

- **Main CLAUDE.md:** Architecture overview, stack, commands
- **Extract jobs:** `src/jobs/`, `src/app/api/cron/`
- **Observability:** `src/observability.js`
- **SDE loaders:** `src/sde*.ts`, `src/sdeCache.ts`
- **Supabase:** `src/supabase.js`, `src/utils/supabase/`

---

**Last Updated:** 2026-08-12 (closed out; see [Outcome](#outcome))
