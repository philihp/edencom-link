# Fluid Compute Memory Optimization Project

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

## Status

| Stage | Status | Date |
|-------|--------|------|
| 1. Discovery | TBD | [FILL IN] |
| 2. Analysis | TBD | [FILL IN] |
| 3. Solutions | TBD | [FILL IN] |
| 4. Roadmap | TBD | [FILL IN] |
| 5. Monitoring | TBD | [FILL IN] |

## Related Documentation

- **Main CLAUDE.md:** Architecture overview, stack, commands
- **Extract jobs:** `src/jobs/`, `src/app/api/cron/`
- **Observability:** `src/observability.js`
- **SDE loaders:** `src/sde*.ts`, `src/sdeCache.ts`
- **Supabase:** `src/supabase.js`, `src/utils/supabase/`

---

**Maintainer:** [TBD]  
**Last Updated:** [2026-07-21]  
**Next Review:** [TBD]
