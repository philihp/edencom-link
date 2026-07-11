// Lightweight metric emission for Vercel Observability.
//
// Each call writes one structured JSON line to stdout, which Vercel ingests from
// the function's logs — so the fields below are queryable and aggregatable in
// the Observability dashboard (and any attached log drain) without shipping an
// OpenTelemetry exporter. That zero-dependency choice is deliberate: adding
// @vercel/otel would mean a package.json + lockfile change, and this repo's
// lockfile can't be regenerated in every environment (the private @eveshipfit
// registry). This module is the single seam to later swap in @vercel/otel
// metrics (a Counter/Histogram) without touching the call sites.
//
// Convention: every line carries a stable `metric` name plus flat, low-cardinality
// dimensions, so a query can group by `metric` + `job` + `outcome`.
const recordMetric = (metric, fields = {}) => {
  console.log(JSON.stringify({ metric, ...fields }))
}

// One ESI conditional (ETag) request outcome — see esiConditionalJson in
// src/esi.js and the character-orders/-wallet-transactions/-industry-jobs jobs.
// Group by (job, outcome) to chart the 304 hit rate; `duration_ms` gives the
// round-trip latency (a 304 is typically much faster and skips the DB reconcile).
//   outcome: 'not_modified' (304, reconcile skipped) | 'modified' (200, reconciled)
//   conditional: whether an If-None-Match was sent (false only on the first-ever run)
//   rows: fetched row count on 'modified', null on 'not_modified'
export const recordEsiConditional = ({
  job,
  characterId,
  characterName,
  outcome,
  conditional,
  rows = null,
  durationMs,
}) =>
  recordMetric('esi.conditional_request', {
    job,
    character_id: characterId,
    character: characterName,
    outcome,
    conditional,
    rows,
    duration_ms: durationMs,
  })
