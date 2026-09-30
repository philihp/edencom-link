// The five-minute rule: which heartbeat rows mean a unit of work just ran,
// and which loop results mean a run did nothing the user should see.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ranNothingRecently, RECENT_RUN_MS, recentlyRan } from '../src/jobs/recentRun.js'

const NOW = Date.parse('2026-09-30T03:02:59Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

test('a run that ended ok inside the window counts', () => {
  assert.equal(recentlyRan([{ started_at: ago(90_000), ended_at: ago(60_000), ok: true }], NOW), true)
})

test('a run that ended ok outside the window does not', () => {
  assert.equal(
    recentlyRan([{ started_at: ago(RECENT_RUN_MS + 120_000), ended_at: ago(RECENT_RUN_MS + 1), ok: true }], NOW),
    false
  )
})

test('a run still going counts while it is young, and reads as stuck once old', () => {
  assert.equal(recentlyRan([{ started_at: ago(30_000), ended_at: null, ok: null }], NOW), true)
  assert.equal(recentlyRan([{ started_at: ago(RECENT_RUN_MS + 1), ended_at: null, ok: null }], NOW), false)
})

test('a failed run never counts: the next start is the retry', () => {
  assert.equal(recentlyRan([{ started_at: ago(90_000), ended_at: ago(60_000), ok: false }], NOW), false)
})

test('a skip counts as a run: the corp was answered', () => {
  assert.equal(recentlyRan([{ started_at: ago(90_000), ended_at: ago(60_000), ok: true }], NOW), true)
})

test('no rows, or unreadable stamps, mean it did not just run', () => {
  assert.equal(recentlyRan([], NOW), false)
  assert.equal(recentlyRan([{ started_at: 'earlier', ended_at: null, ok: null }], NOW), false)
})

test('ranNothingRecently is true only for a loop that stopped everything for having just run', () => {
  assert.equal(ranNothingRecently({ ran: 0, skippedRecent: 3 }), true)
  assert.equal(ranNothingRecently({ ran: 2, skippedRecent: 3 }), false)
  assert.equal(ranNothingRecently({ ran: 0, skippedRecent: 0 }), false)
  assert.equal(ranNothingRecently(undefined), false)
  assert.equal(ranNothingRecently(new Set()), false)
})
