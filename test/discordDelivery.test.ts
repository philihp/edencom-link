// Unit coverage for the pure Discord delivery-outcome seam
// (docs/discord-bot/05-notification-sender.md). The mapping from an HTTP
// status to "stamp sent / disable the channel / back off / retry" is the part
// that decides whether a kicked bot quietly burns ten retries or is retired
// immediately, so it's pinned here rather than discovered in production.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyDeliveryStatus,
  deliveryPayload,
  isDeliverable,
  MAX_ATTEMPTS,
  retryAfterMs,
} from '../src/jobs/discordDelivery.js'

test('2xx is a send', () => {
  assert.equal(classifyDeliveryStatus(200), 'sent')
  assert.equal(classifyDeliveryStatus(204), 'sent')
})

test('403 and 404 permanently disable the channel', () => {
  assert.equal(classifyDeliveryStatus(403), 'disabled')
  assert.equal(classifyDeliveryStatus(404), 'disabled')
})

test('429 throttles, everything else retries', () => {
  assert.equal(classifyDeliveryStatus(429), 'throttled')
  assert.equal(classifyDeliveryStatus(500), 'retry')
  assert.equal(classifyDeliveryStatus(502), 'retry')
  assert.equal(classifyDeliveryStatus(401), 'retry')
})

const now = new Date('2026-08-06T12:00:00Z')
const channel = { id: 'chan-a', channel_id: '123', disabled_at: null }
const row = { sent_at: null, attempts: 0, scheduled_at: '2026-08-06T11:00:00Z' }

test('a pending, due row aimed at a live channel is deliverable', () => {
  assert.equal(isDeliverable({ row, channel, now }), true)
})

test('already-sent, over-cap, and not-yet-due rows are not deliverable', () => {
  assert.equal(isDeliverable({ row: { ...row, sent_at: '2026-08-06T11:30:00Z' }, channel, now }), false)
  assert.equal(isDeliverable({ row: { ...row, attempts: MAX_ATTEMPTS }, channel, now }), false)
  assert.equal(isDeliverable({ row: { ...row, scheduled_at: '2026-08-06T13:00:00Z' }, channel, now }), false)
})

test('a missing or disabled channel makes a row undeliverable', () => {
  assert.equal(isDeliverable({ row, channel: null, now }), false)
  assert.equal(isDeliverable({ row, channel: { ...channel, disabled_at: '2026-08-05T00:00:00Z' }, now }), false)
})

test('the payload never pings anyone', () => {
  assert.deepEqual(deliveryPayload('Friendly Den Reinforced - QQGH-G V'), {
    content: 'Friendly Den Reinforced - QQGH-G V',
    allowed_mentions: { parse: [] },
  })
})

test('retry_after is seconds, clamped, and tolerant of junk', () => {
  assert.equal(retryAfterMs({ retry_after: 1.5 }), 1500)
  assert.equal(retryAfterMs({ retry_after: 30 }), 5000, 'clamped to the cap')
  assert.equal(retryAfterMs({ retry_after: 0 }), 0)
  assert.equal(retryAfterMs(null), 0)
  assert.equal(retryAfterMs({}), 0)
  assert.equal(retryAfterMs({ retry_after: 'soon' }), 0)
})
