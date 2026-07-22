# Stage 5: Monitoring & Validation

**Goal:** Establish metrics to track memory optimization progress and detect regressions.

## Baseline Metrics (To Establish in Phase 1)

### Current State Snapshot
```yaml
date_captured: [FILL IN]
total_monthly_memory_cost: $[FILL IN]
top_3_memory_consumers: 
  - job_name: [FILL IN]
    peak_memory_mb: [FILL IN]
    frequency: [FILL IN]
    cost_per_month: $[FILL IN]
  - [...]
  - [...]

avg_function_memory_mb: [FILL IN]
p95_function_memory_mb: [FILL IN]
p99_function_memory_mb: [FILL IN]
```

## Key Performance Indicators (KPIs)

### 1. Memory Metrics per Job Type
**Tracked in:** Vercel Observability, custom metrics

| Job | Baseline Peak (MB) | Phase 1 Target | Phase 2 Target | Phase 3 Target |
|-----|---|---|---|---|
| character-assets | TBD | TBD | TBD | TBD |
| character-blueprints | TBD | TBD | TBD | TBD |
| sde-mirror | TBD | TBD | TBD | TBD |
| corp-assets | TBD | TBD | TBD | TBD |
| CSV export (large hangar) | TBD | TBD | TBD | TBD |

### 2. Aggregate Cost Metrics
| Metric | Baseline | Phase 1 Goal | Phase 2 Goal | Phase 3 Goal |
|--------|----------|-------------|-------------|-------------|
| Monthly memory cost | $[X] | -15% | -30% | -40% |
| Avg function memory | [A] MB | -10% | -25% | -35% |
| P95 function memory | [B] MB | -15% | -30% | -40% |
| P99 function memory | [C] MB | -20% | -35% | -45% |

### 3. Data Quality / Consistency Metrics
**Tracked in:** Application logs, heartbeat table

| Check | Target | Frequency |
|-------|--------|-----------|
| Asset row count ±0.1% before/after optimization | Pass | Per extract job |
| Blueprint count consistency | Pass | Per extract job |
| CSV export row count vs DB | ≤1 row diff | Per export test |
| SDE mirror row counts vs prior build | ≤0.01% diff | Per mirror run |
| Cache hit rate (SDE loaders) | ≥90% | Daily |

### 4. Performance Metrics (Side Effects)
**Tracked in:** Vercel Observability

| Metric | Baseline | Target | Acceptable Degradation |
|--------|----------|--------|------------------------|
| Extract job latency (mean) | TBD | ≤+5% | ≤+10% |
| CSV export latency (p95) | TBD | ≤+10% | ≤+20% |
| API response time (p99) | TBD | ≤+5% | ≤+10% |
| SDE mirror duration | TBD | ≤+10% | ≤+15% |

## Observability Implementation

### Metrics to Emit

In `src/observability.js`, add the following structured log lines:

```javascript
// Job memory tracking
{
  "metric": "job_memory",
  "job": "character-assets",
  "phase": "fetching|reconciling|inserting|complete",
  "memory_rss_mb": 256,
  "memory_heap_mb": 128,
  "memory_heap_used_mb": 96,
  "timestamp_ms": 1234567890
}

// Cache metrics
{
  "metric": "sde_cache",
  "cache_type": "types|systems|stations",
  "operation": "hit|miss|evict",
  "cache_size": 5000,
  "hit_rate_percent": 92.5,
  "timestamp_ms": 1234567890
}

// Extract job reconciliation
{
  "metric": "reconcile",
  "job": "character-assets",
  "character_id": 12345,
  "items_old": 500,
  "items_new": 510,
  "items_added": 20,
  "items_deleted": 10,
  "items_updated": 5,
  "duration_ms": 250,
  "memory_delta_mb": 45
}

// API streaming
{
  "metric": "api_stream",
  "route": "/api/character/assets",
  "row_count": 5000,
  "chunk_size": 500,
  "stream_duration_ms": 1200,
  "peak_memory_mb": 80
}
```

### Dashboard Setup

Create a Vercel Observability dashboard with:

1. **Memory Trends (30-day rolling)**
   - Line chart: avg/p95/p99 memory per job
   - Breakdown by job type
   - Overlay of deploy events for correlation

2. **Top Memory Consumers (Live)**
   - Table: rank by peak memory
   - Sortable by frequency, cost, recent date

3. **Optimization Progress**
   - Gauge charts per phase showing % reduction vs baseline
   - Target line for each phase

4. **Data Quality**
   - Heartbeat count per job (should be stable)
   - Alert if heartbeat fails
   - Cache hit rates per cache type

## Validation Checkpoints

### Post-Phase 1 (Week 2)
- [ ] Run all extract jobs; check for missing/duplicate rows
- [ ] Export CSV for largest character hangar; validate row count
- [ ] Spot-check 5 random asset items (location, quantity, name)
- [ ] Verify SDE mirror row counts unchanged
- [ ] Confirm memory reduction in line with estimates

**If validation fails:**
- Rollback to pre-Phase-1 commit
- Debug with heap snapshot comparison
- Re-profile to understand regression

### Post-Phase 2 (Week 5)
- [ ] Full 24h of extract jobs with new streaming logic
- [ ] Reconciliation results identical to Phase 1 baseline
- [ ] Large asset hangar CSV export (measure memory delta)
- [ ] SDE mirror run with streaming decompression
- [ ] Verify cache behavior under load (concurrency test)

**If validation fails:**
- Disable Phase 2 changes for that job (revert one at a time)
- Investigate data race conditions
- Add retry logic if transient

### Post-Phase 3 (Week 8)
- [ ] 7-day observability data shows sustained improvement
- [ ] No spike in error rates or failures
- [ ] Cache hit rate stable ≥90%
- [ ] No customer complaints about data staleness
- [ ] Cost tracking shows expected savings

**If validation fails:**
- Check if new workload patterns emerged (more characters added?)
- Re-baseline and adjust targets
- Consider Phase 4 work if still critical

## Regression Testing Strategy

### Automated Tests
- [ ] Asset export CSV compares row counts before/after each optimization
- [ ] SDE mirror validates final row counts match SDE build metadata
- [ ] Cache hit rate assertion (≥85% threshold)

### Manual Testing
- [ ] Monthly: export largest asset hangar, import to test spreadsheet
- [ ] Monthly: run `sde-mirror` locally, compare row counts
- [ ] Monthly: profile a character-assets job with `--inspect`

### Canary Deployment
- [ ] Deploy Phase 1 to a fraction of traffic (10%)
- [ ] Monitor error rate and memory for 1 week
- [ ] Roll out to 100% if no issues

## Long-Term Monitoring (Post-Optimization)

### Monthly Review
- [ ] Check memory trend vs. baseline
- [ ] Alert if regression > 5% month-over-month
- [ ] Update targets if data size has grown significantly

### Quarterly Review
- [ ] Revisit Phase 4 (deferred work)
- [ ] Consider if further optimization is ROI-positive
- [ ] Assess external factors (new ESI endpoints, bigger users)

### Documentation
- [ ] Keep CLAUDE.md updated with cache TTL, batch sizes, and key memory configs
- [ ] Document any manual tuning performed
- [ ] Log lessons learned for future optimization cycles

## Alerting Rules

Set up Vercel Observability alerts:

```yaml
- name: memory_regression
  condition: "current_p95_memory > baseline_p95_memory * 1.10"
  severity: warning
  actions: [notify_slack, create_issue]

- name: cache_hit_rate_drop
  condition: "cache_hit_rate < 85%"
  severity: info
  actions: [notify_slack, log_investigation_data]

- name: extract_job_timeout
  condition: "job_duration > 5min"
  severity: warning
  actions: [notify_slack]

- name: data_quality_check
  condition: "reconcile_mismatch > 0.1%"
  severity: critical
  actions: [notify_slack, page_oncall]
```

## Success Criteria (Overall)

- [ ] Memory cost reduced by 25–50% vs baseline
- [ ] No data inconsistencies or missing rows detected
- [ ] Performance degradation ≤ 10% for all jobs
- [ ] Cache hit rates sustained ≥ 90%
- [ ] Observability dashboard live and feeding cost tracking
- [ ] Documentation updated for future maintainers
- [ ] No customer-facing issues related to changes

---

## References

- **Baseline metrics:** See [Stage 1: Discovery](01-discovery.md)
- **Implementation details:** See [Stage 4: Roadmap](04-implementation-roadmap.md)
- **Observability code:** `src/observability.js`
- **Vercel dashboard:** https://vercel.com/[project]/analytics
