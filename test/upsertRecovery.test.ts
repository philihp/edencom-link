// Unit coverage for the sde-mirror upsert recovery seam. The classification
// decides whether a nightly ingest self-heals or dies: treating a statement
// timeout as fatal is what lost the 2026-08-15 run, and treating a constraint
// violation as retryable would grind a broken file through six attempts before
// reporting the same error.
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_ATTEMPTS, MIN_BISECT_ROWS, planUpsertRecovery, RETRY_BACKOFF_MS } from '../src/jobs/upsertRecovery.js'

test('statement timeout on a big chunk bisects', () => {
  assert.deepEqual(
    planUpsertRecovery({ code: '57014', message: 'canceling statement due to statement timeout' }, 500, 0),
    {
      action: 'bisect',
    }
  )
})

test('statement timeout is recognized by message when the code is absent', () => {
  // PostgREST sometimes surfaces the Postgres message without its SQLSTATE.
  assert.deepEqual(planUpsertRecovery({ message: 'canceling statement due to statement timeout' }, 500, 0), {
    action: 'bisect',
  })
})

test('statement timeout at the bisect floor retries instead', () => {
  const plan = planUpsertRecovery({ code: '57014', message: 'statement timeout' }, MIN_BISECT_ROWS, 1)
  assert.deepEqual(plan, { action: 'retry', waitMs: RETRY_BACKOFF_MS[1] })
})

test('connection-class SQLSTATEs retry with backoff', () => {
  assert.deepEqual(planUpsertRecovery({ code: '08006', message: 'connection failure' }, 500, 0), {
    action: 'retry',
    waitMs: RETRY_BACKOFF_MS[0],
  })
  assert.deepEqual(planUpsertRecovery({ code: '57P01', message: 'terminating connection' }, 500, 0), {
    action: 'retry',
    waitMs: RETRY_BACKOFF_MS[0],
  })
})

test('a codeless network error retries', () => {
  assert.deepEqual(planUpsertRecovery({ message: 'TypeError: fetch failed' }, 500, 2), {
    action: 'retry',
    waitMs: RETRY_BACKOFF_MS[2],
  })
})

test('a 5xx-shaped error retries', () => {
  assert.deepEqual(planUpsertRecovery({ status: 503, message: 'Service Unavailable' }, 500, 0), {
    action: 'retry',
    waitMs: RETRY_BACKOFF_MS[0],
  })
})

test('backoff is capped at the last rung, not extended', () => {
  const plan = planUpsertRecovery({ message: 'fetch failed' }, 500, MAX_ATTEMPTS - 1)
  assert.deepEqual(plan, { action: 'retry', waitMs: RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] })
})

test('a constraint violation fails on the first attempt', () => {
  // Data-shaped errors replay identically; retrying only delays the report.
  assert.deepEqual(planUpsertRecovery({ code: '23505', message: 'duplicate key value' }, 500, 0), { action: 'fail' })
})

test('a message-only error that is not network-shaped fails', () => {
  assert.deepEqual(planUpsertRecovery({ message: 'invalid input syntax for type bigint' }, 500, 0), { action: 'fail' })
})

test('attempt exhaustion fails even for a retryable error', () => {
  assert.deepEqual(planUpsertRecovery({ code: '57014', message: 'statement timeout' }, 500, MAX_ATTEMPTS), {
    action: 'fail',
  })
})
