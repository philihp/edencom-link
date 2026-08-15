// The universe-structures resolve pass used to run until Vercel killed it at
// 800 seconds — ~860 candidates × ~77 tokens of ESI calls, nightly, with
// failures never remembered. A timeout records no end heartbeat, so /jobs
// showed the job as stale rather than as failing.
//
// Two decisions keep it inside its budget now, and both are the kind that fail
// quietly in the wrong direction: cache too eagerly and a resolvable structure
// goes unnamed for a week; stand down too late and the whole application eats
// 420s. Pinned here, offline.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ERROR_LIMIT_FLOOR,
  isDefinitiveFailure,
  shouldStandDown,
  UNRESOLVED_TTL_DAYS,
  unresolvedCutoff,
} from '../src/jobs/structureResolution.js'

test('only a definitive answer about the structure parks it', () => {
  // 403 = no docking access for this character, 404 = no such structure. Both
  // are facts about the structure and worth remembering.
  assert.equal(isDefinitiveFailure({ status: 403 }), true)
  assert.equal(isDefinitiveFailure({ status: 404 }), true)
})

test('a transient failure never parks a structure', () => {
  // The dangerous direction: parking on any of these would silence a structure
  // that nobody had actually been refused, for a week, because of one bad
  // minute.
  assert.equal(isDefinitiveFailure({ status: 420 }), false)
  assert.equal(isDefinitiveFailure({ status: 500 }), false)
  assert.equal(isDefinitiveFailure({ status: 503 }), false)
  assert.equal(isDefinitiveFailure({ status: 401 }), false)
  // No response at all (a network error, or no scoped token ever tried).
  assert.equal(isDefinitiveFailure(undefined), false)
  assert.equal(isDefinitiveFailure(null), false)
  assert.equal(isDefinitiveFailure(new Error('socket hang up')), false)
})

test('an outright 420 stands the pass down', () => {
  assert.equal(shouldStandDown({ status: 420 }), true)
})

test('a nearly-spent error budget stands the pass down before the 420s', () => {
  assert.equal(shouldStandDown({ status: 403, errorLimitRemain: ERROR_LIMIT_FLOOR }), true)
  assert.equal(shouldStandDown({ status: 403, errorLimitRemain: ERROR_LIMIT_FLOOR - 1 }), true)
  assert.equal(shouldStandDown({ status: 403, errorLimitRemain: 0 }), true)
})

test('a healthy error budget keeps the pass going', () => {
  assert.equal(shouldStandDown({ status: 403, errorLimitRemain: ERROR_LIMIT_FLOOR + 1 }), false)
  assert.equal(shouldStandDown({ status: 403, errorLimitRemain: 99 }), false)
})

test('a missing error-limit header reads as unknown, not as exhausted', () => {
  // ESI omits the header on some responses. Treating absent as zero would stand
  // the pass down on its first 403 and it would never resolve anything again.
  assert.equal(shouldStandDown({ status: 403, errorLimitRemain: null }), false)
  assert.equal(shouldStandDown({ status: 403 }), false)
  assert.equal(shouldStandDown({}), false)
  assert.equal(shouldStandDown(), false)
})

test('the park expires after the TTL', () => {
  const now = Date.parse('2026-08-14T12:00:00.000Z')
  assert.equal(unresolvedCutoff(now), '2026-08-07T12:00:00.000Z')

  // A mark older than the cutoff is no longer excluded, so access granted in
  // the meantime is picked up within the week.
  const day = 24 * 60 * 60 * 1000
  const parkedAt = new Date(now - (UNRESOLVED_TTL_DAYS + 1) * day).toISOString()
  assert.ok(parkedAt < unresolvedCutoff(now), 'a mark past the TTL sorts before the cutoff')

  const fresh = new Date(now - day).toISOString()
  assert.ok(fresh > unresolvedCutoff(now), 'a mark inside the TTL sorts after the cutoff')
})
