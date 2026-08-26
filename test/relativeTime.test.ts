// The relative fuel countdown: coarse, two units, future-only, and computed
// entirely from the two instants it is given (the page passes a fixed `now`,
// so hydration has nothing to disagree with).
import assert from 'node:assert/strict'
import test from 'node:test'

import { formatRelativeFuture } from '../src/app/relativeTime.ts'

const NOW = new Date('2026-08-26T12:00:00Z')

test('months carry their leftover days', () => {
  assert.equal(formatRelativeFuture('2026-12-09T12:00:00Z', NOW), 'in 3 months 13 days')
  assert.equal(formatRelativeFuture('2026-09-26T12:00:00Z', NOW), 'in 1 month')
})

test('weeks below a month, days below a week', () => {
  assert.equal(formatRelativeFuture('2026-09-10T12:00:00Z', NOW), 'in 2 weeks 1 day')
  assert.equal(formatRelativeFuture('2026-09-02T12:00:00Z', NOW), 'in 1 week')
  assert.equal(formatRelativeFuture('2026-08-29T18:00:00Z', NOW), 'in 3 days 6 hours')
  assert.equal(formatRelativeFuture('2026-08-26T20:00:00Z', NOW), 'in 8 hours')
  assert.equal(formatRelativeFuture('2026-08-26T12:30:00Z', NOW), 'in under an hour')
})

test('a month is a calendar month, not thirty days', () => {
  // Jan 31 → Feb 28 is under one month by day count but exactly the clamp
  // case: stepping Jan 31 forward one month must not overshoot into March.
  const jan = new Date('2026-01-31T00:00:00Z')
  assert.equal(formatRelativeFuture('2026-03-03T00:00:00Z', jan), 'in 1 month 3 days')
})

test('the past and the unparseable render nothing', () => {
  assert.equal(formatRelativeFuture('2026-08-26T11:00:00Z', NOW), null)
  assert.equal(formatRelativeFuture('garbage', NOW), null)
})
