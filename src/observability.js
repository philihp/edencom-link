// Lightweight metric emission for Vercel Observability.
//
// Each call writes one structured JSON line to stdout, which Vercel ingests from
// the function's logs — so the fields below are queryable and aggregatable in
// the Observability dashboard (and any attached log drain) without shipping an
// OpenTelemetry exporter. That zero-dependency choice is deliberate: adding
// @vercel/otel would pull a heavy dependency tree in for a single metric line.
// This module is the single seam to later swap in @vercel/otel metrics (a
// Counter/Histogram) without touching the call sites.
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

// One job invocation's memory footprint — emitted from the workflow heartbeat
// wrapper (src/workflows/lib.ts) and per-entry from the sde-mirror ingest. Group by
// (job) and chart max(peak_rss_mb) to size the function's `memory` limit
// against real usage instead of guessing. `maxRSS` (process.resourceUsage, KB
// on Linux) is the process-wide high-water mark; under Vercel Fluid Compute
// the instance is reused across invocations, so it reflects the whole worker —
// which is exactly the number the configured memory limit has to cover.
//   entry: optional finer-grained label (e.g. the SDE zip entry a slice ingested)
export const recordPeakRss = ({ job, entry = null }) => {
  const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10
  const mem = process.memoryUsage()
  recordMetric('job.peak_rss', {
    job,
    entry,
    peak_rss_mb: Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
    rss_mb: mb(mem.rss),
    heap_used_mb: mb(mem.heapUsed),
    external_mb: mb(mem.external),
  })
}

// One Discord interaction outcome — see src/app/api/discord/interactions/route.ts.
// Group by (type, outcome) to watch signature rejections (portal validation and
// spoof attempts) and, later, command traffic.
//   type: the Discord interaction type (1=PING, 2=APPLICATION_COMMAND, ...), or null
//   outcome: 'pong' | 'unimplemented' | 'unhandled' | 'bad_signature'
export const recordDiscordInteraction = ({ type, outcome }) => recordMetric('discord.interaction', { type, outcome })

// One outbound Discord message attempt — see src/jobs/discordNotificationSend.js.
// Group by outcome to watch delivery health without an OpenTelemetry exporter:
// a rising 'disabled' count means bots are being kicked, 'throttled' means the
// send rate is brushing Discord's limits.
//   outcome: 'sent' | 'disabled' | 'throttled' | 'retry'
//   status: the HTTP status Discord returned
//   duration_ms: round-trip latency of the POST
export const recordDiscordSend = ({ outcome, status, duration_ms }) =>
  recordMetric('discord.send', { outcome, status, duration_ms })
