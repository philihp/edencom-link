// Unit coverage for the Server-Timing header serializer (src/serverTiming.ts).
// What's worth pinning is the grammar: a metric name the spec allows, a
// quoted description, and the folding/bounding that keeps the header small —
// a header a browser can't parse shows nothing at all, so a malformed name is
// not a cosmetic bug.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateSpans,
  applyServerTiming,
  collectServerTiming,
  isCollectingServerTiming,
  recordServerTimingSpan,
  serializeServerTiming,
  timed,
  type ServerTimingSpan,
} from '../src/serverTiming.ts'

const span = (name: string, durationMs: number, description: string | null = null): ServerTimingSpan => ({
  name,
  description,
  durationMs,
})

test('total always leads, and parts follow slowest first', () => {
  const header = serializeServerTiming([span('db.assets', 10), span('sde.types', 90)], 120)
  assert.equal(header, 'total;dur=120, sde.types;dur=90, db.assets;dur=10')
})

test('repeats of one name fold into a summed metric carrying the count', () => {
  const header = serializeServerTiming([span('db.assets', 10), span('db.assets', 30), span('db.assets', 5)], 50)
  assert.equal(header, 'total;dur=50, db.assets;dur=45;desc="3×"')
})

test('a shared description survives folding; differing ones drop out', () => {
  assert.match(serializeServerTiming([span('x', 1, 'jita'), span('x', 1, 'jita')], 2), /desc="jita \(2×\)"/)
  assert.equal(
    serializeServerTiming([span('x', 1, 'jita'), span('x', 1, 'amarr')], 2),
    'total;dur=2, x;dur=2;desc="2×"'
  )
})

// A metric name is an RFC 9110 token — no slashes, spaces or quotes. Span names
// are built from URL paths (src/utils/supabase/timedFetch.ts), so this is the
// guard that a table name with a slash in it can't corrupt the header.
test('names are sanitized to token characters and descriptions are escaped', () => {
  assert.match(serializeServerTiming([span('rest/v1 assets', 1)], 1), /rest_v1_assets;dur=1/)
  assert.equal(
    serializeServerTiming([span('x', 1, 'say "hi"\\now')], 1),
    'total;dur=1, x;dur=1;desc="say \\"hi\\"\\\\now"'
  )
})

test('durations round to a tenth of a millisecond', () => {
  assert.equal(serializeServerTiming([span('x', 1.26)], 3.041), 'total;dur=3, x;dur=1.3')
})

// The cap keeps a pathological request (one span per row) from answering a
// header large enough for a proxy to drop — the fold has to be lossless in
// total, or the header lies about where the time went.
test('past the metric cap the tail folds into one `other` entry', () => {
  const many = Array.from({ length: 40 }, (_, i) => span(`db.t${i}`, i + 1))
  const header = serializeServerTiming(many, 1000)
  const metrics = header.split(', ')
  assert.equal(metrics.length, 25) // total + MAX_METRICS
  assert.match(header, /other;dur=153;desc="17 smaller metrics"/)
  assert.equal(
    metrics.slice(1).reduce((sum, m) => sum + Number(m.match(/dur=([\d.]+)/)![1]), 0),
    (40 * 41) / 2
  )
})

test('aggregation preserves every span exactly once', () => {
  const metrics = aggregateSpans([span('a', 1), span('b', 2), span('a', 3)])
  assert.deepEqual(
    metrics.map((m) => [m.name, m.durationMs, m.count]),
    [
      ['a', 4, 2],
      ['b', 2, 1],
    ]
  )
})

// Outside a scope every entry point is inert: a cron job or a page render calls
// the same helpers and must neither collect nor throw.
test('recording outside a collection scope is a no-op', async () => {
  assert.equal(isCollectingServerTiming(), false)
  recordServerTimingSpan('db.assets', 5)
  assert.equal(await timed('db.assets', async () => 'value'), 'value')
})

test('a scope collects spans from anything it awaits, including throws', async () => {
  const header = await collectServerTiming(async () => {
    assert.equal(isCollectingServerTiming(), true)
    await timed('ok', async () => undefined)
    await assert.rejects(
      timed('boom', async () => {
        throw new Error('upstream down')
      })
    )
    recordServerTimingSpan('manual', 7)
    return serializeServerTiming([span('manual', 7)], 7)
  })
  assert.match(header, /manual;dur=7/)
})

// A CDN-held response would serve the first caller's timing to everyone after
// them; no header is better than a header that lies about whose request it is.
test('a publicly cacheable response goes unstamped', async () => {
  const stamp = (cacheControl: string | null) =>
    collectServerTiming(async () => {
      recordServerTimingSpan('db.assets', 5)
      const response = new Response('body', { headers: cacheControl ? { 'cache-control': cacheControl } : {} })
      return applyServerTiming(response).headers.get('Server-Timing')
    })

  assert.equal(await stamp('public, max-age=300, s-maxage=900'), null)
  assert.equal(await stamp('public, max-age=86400, immutable'), null)
  assert.match((await stamp('private, no-store')) ?? '', /db\.assets;dur=5/)
  assert.match((await stamp(null)) ?? '', /db\.assets;dur=5/)
})
