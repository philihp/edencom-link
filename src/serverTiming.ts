// Server-Timing: the request-scoped span collector whose output rides back to
// the browser as a `Server-Timing` response header, so the network panel shows
// *where* a slow response spent its time instead of just how long it took.
//
// Relationship to src/observability.js: `recordRequest` emits one metric line
// per request for aggregate analysis in Vercel Observability (p50/p95 over
// days). This is the per-request, client-visible complement — the same clock,
// a different audience. Neither replaces the other, and this module never
// logs.
//
// Two ways a span gets recorded:
//
//   1. Automatically, for every Supabase/PostgREST round trip, via the
//      instrumented `fetch` the client factories pass to supabase-js
//      (src/utils/supabase/timedFetch.ts). This is where the time goes on
//      nearly every surface here — docs/page-load-performance.md's measurement
//      found a single RPC accounting for 3.2 s of a page — so it is worth
//      having for free rather than per call site.
//   2. Explicitly, wrapping anything else worth naming in `timed()` — the
//      innomin.at appraisal (which blocks on a global queue), a GraphQL
//      execution phase.
//
// Collection is scoped by AsyncLocalStorage, so a helper five frames down
// contributes a span without the caller threading anything through. Outside a
// scope every entry point here is a no-op that adds one Map lookup — which is
// what happens during a page render, since App Router server components have
// no response headers to set (see docs/server-timing.md).
import { AsyncLocalStorage } from 'node:async_hooks'
import { forEach, sum } from 'ramda'

export type ServerTimingSpan = {
  // Serialized as the Server-Timing metric name, so it must survive
  // `metricName` below (RFC 9110 token characters only).
  name: string
  description: string | null
  durationMs: number
}

type Collector = { spans: ServerTimingSpan[]; startedAt: number }

const storage = new AsyncLocalStorage<Collector>()

// A runaway loop (the appraisal queue poller wakes once a second for ~50 s)
// must not grow this unbounded. Spans past the cap are dropped, not summarized:
// by then the metric they'd land in already has enough samples to be the
// obvious culprit.
const MAX_SPANS = 500

// How many distinct metrics reach the header. Everything past it folds into one
// `other` metric, so a pathological request answers a bounded header rather than
// a multi-kilobyte one that proxies may drop.
const MAX_METRICS = 24

export const isCollectingServerTiming = (): boolean => storage.getStore() !== undefined

// Record a span that was timed elsewhere. Silently ignored outside a scope.
export const recordServerTimingSpan = (name: string, durationMs: number, description: string | null = null): void => {
  const collector = storage.getStore()
  if (!collector || collector.spans.length >= MAX_SPANS) return
  collector.spans.push({ name, description, durationMs })
}

// Time `run` as one span. Returns exactly what `run` returns, and records the
// span even when it throws — a failed 30 s upstream call is the most
// interesting entry in the header, not one to omit.
export const timed = async <T>(name: string, run: () => Promise<T>, description: string | null = null): Promise<T> => {
  if (!isCollectingServerTiming()) return run()
  const startedAt = performance.now()
  try {
    return await run()
  } finally {
    recordServerTimingSpan(name, performance.now() - startedAt, description)
  }
}

// RFC 9110 token characters. Anything else (a `/` from a URL path, a space)
// becomes `_`, since a malformed metric name makes the whole header
// unparseable in devtools rather than just that entry.
const metricName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9!#$%&'*+\-.^_`|~]/g, '_').slice(0, 48)
  return cleaned === '' ? 'span' : cleaned
}

// desc is a quoted-string; only `"` and `\` need escaping inside one.
const quote = (raw: string): string => `"${raw.replace(/[\\"]/g, '\\$&').slice(0, 120)}"`

const round = (ms: number): number => Math.round(ms * 10) / 10

type Metric = { name: string; description: string | null; durationMs: number; count: number }

// Fold repeats of the same name into one metric: eight `db.character_asset`
// round trips read better as one 240 ms entry saying `8×` than as eight
// same-named entries devtools stacks on top of each other. Durations are
// summed, which over-counts concurrent spans — accepted, because the question
// this answers is "how much of the response is this dependency worth", not
// "what does the wall clock look like".
export const aggregateSpans = (spans: ServerTimingSpan[]): Metric[] => {
  const byName = new Map<string, Metric>()
  forEach((span: ServerTimingSpan) => {
    const name = metricName(span.name)
    const existing = byName.get(name)
    if (!existing) {
      byName.set(name, { name, description: span.description, durationMs: span.durationMs, count: 1 })
      return
    }
    existing.durationMs += span.durationMs
    existing.count += 1
    // Descriptions of repeats are dropped rather than joined: the count is
    // the useful part, and a joined list is what blows the header up.
    if (existing.description !== span.description) existing.description = null
  }, spans)
  return [...byName.values()]
}

// Slowest first, so the entry that explains the response is the first one read
// — and so that what falls off the MAX_METRICS cliff is the noise.
const bounded = (metrics: Metric[]): Metric[] => {
  const sorted = [...metrics].sort((a, b) => b.durationMs - a.durationMs)
  if (sorted.length <= MAX_METRICS) return sorted
  const kept = sorted.slice(0, MAX_METRICS - 1)
  const rest = sorted.slice(MAX_METRICS - 1)
  return [
    ...kept,
    {
      name: 'other',
      description: `${rest.length} smaller metrics`,
      // Count 1 so the renderer doesn't append a redundant `(n×)` — the
      // description already says how many folded in.
      count: 1,
      durationMs: sum(rest.map((m) => m.durationMs)),
    },
  ]
}

const render = (metric: Metric): string => {
  const note =
    metric.count > 1
      ? metric.description
        ? `${metric.description} (${metric.count}×)`
        : `${metric.count}×`
      : metric.description
  return `${metric.name};dur=${round(metric.durationMs)}${note ? `;desc=${quote(note)}` : ''}`
}

// The whole header value: `total` first (the number the browser already knows,
// repeated so the parts have something to add up against), then the parts.
// Pure, so test/serverTiming.test.ts can pin the grammar.
export const serializeServerTiming = (spans: ServerTimingSpan[], totalMs: number): string =>
  [
    render({ name: 'total', description: null, durationMs: totalMs, count: 1 }),
    ...bounded(aggregateSpans(spans)).map(render),
  ].join(', ')

// A response a shared cache may keep (`public`, or any `s-maxage`) is served
// to later callers unchanged — header included. Stamping one would hand
// everybody after the first the *first* request's timing, dressed up as their
// own, which is worse than no header at all: the /sheets/market CDN cache
// holds an answer for up to a week. So those go unstamped, and the timing for
// them lives in the request.timing metric instead.
const publiclyCached = (response: Response): boolean => {
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? ''
  return cacheControl.includes('s-maxage') || /(^|[\s,])public([\s,]|$)/.test(cacheControl)
}

// Set the header on a response built inside a collection scope. A no-op
// outside one, and tolerant of an immutable Headers (a redirect, a response
// proxied straight from fetch) — timing is diagnostic, never worth a 500.
export const applyServerTiming = <R extends Response>(response: R): R => {
  const collector = storage.getStore()
  if (!collector || publiclyCached(response)) return response
  try {
    response.headers.set(
      'Server-Timing',
      serializeServerTiming(collector.spans, performance.now() - collector.startedAt)
    )
  } catch {
    // Immutable headers; nothing to do and nothing worth failing over.
  }
  return response
}

// Run `run` in a fresh collection scope. Callers that answer a Response should
// prefer `withServerTiming` below, which also stamps it.
export const collectServerTiming = <T>(run: () => Promise<T>): Promise<T> =>
  storage.run({ spans: [], startedAt: performance.now() }, run)

// Wrap a route handler so everything it awaits is collected and the response it
// answers carries the header. Signature-transparent, so it composes with the
// framework's `(request, context)` handlers and with withRequestTiming.
export const withServerTiming =
  <A extends unknown[], R extends Response>(handler: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    collectServerTiming(async () => applyServerTiming(await handler(...args)))
