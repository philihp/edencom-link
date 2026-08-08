// Unit coverage for the industry-job reconcile classification, shared by
// character-industry-jobs and corp-industry-jobs.
//
// The rule worth pinning is what happens to a row that vanishes from the ESI
// listing. ESI's include_completed window is bounded by the job's *install*
// (~90 days), not by when it was delivered, so a job that runs longer than that
// disappears before its delivered state is ever observable. Leaving such rows
// untouched pinned them to is_current with a stale `active` that nothing could
// supersede — month-old finished ME research kept rendering on /industry.
// Terminal rows must still survive, or the view stops being a job history.
import assert from 'node:assert/strict'
import test from 'node:test'

import { TERMINAL_STATUSES, jobSignature, partitionJobs } from '../src/jobs/industryJobReconcile.js'

// A current (is_current) row as fetchCurrentRows selects it.
const row = (id: number, job_id: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  job_id,
  status,
  pause_date: null,
  completed_date: null,
  completed_character_id: null,
  successful_runs: null,
  ...extra,
})

// A job as ESI returns it.
const esi = (job_id: number, status: string, extra: Record<string, unknown> = {}) => ({
  job_id,
  status,
  ...extra,
})

test('an unchanged job is touched, not reopened', () => {
  const { touchIds, closeIds, openJobs, agedOutIds } = partitionJobs([row(1, 100, 'active')], [esi(100, 'active')])
  assert.deepEqual(touchIds, [1])
  assert.deepEqual(closeIds, [])
  assert.deepEqual(openJobs, [])
  assert.deepEqual(agedOutIds, [])
})

test('a job whose status advanced closes the old row and opens a new one', () => {
  const { touchIds, closeIds, openJobs, agedOutIds } = partitionJobs(
    [row(1, 100, 'active')],
    [esi(100, 'delivered', { completed_date: '2026-08-01T00:00:00Z' })]
  )
  assert.deepEqual(touchIds, [])
  assert.deepEqual(closeIds, [1])
  assert.equal(openJobs.length, 1)
  assert.equal(openJobs[0].status, 'delivered')
  assert.deepEqual(agedOutIds, [])
})

test('a job never seen before is opened without closing anything', () => {
  const { touchIds, closeIds, openJobs, agedOutIds } = partitionJobs([], [esi(100, 'active')])
  assert.deepEqual(touchIds, [])
  assert.deepEqual(closeIds, [])
  assert.equal(openJobs.length, 1)
  assert.deepEqual(agedOutIds, [])
})

// The bug: a long ME research job ages out of include_completed while our last
// observation still says `active`, and nothing can ever supersede it.
test('a non-terminal row absent from the listing is aged out', () => {
  const { touchIds, closeIds, openJobs, agedOutIds } = partitionJobs(
    [row(1, 100, 'active'), row(2, 200, 'active')],
    [esi(200, 'active')]
  )
  assert.deepEqual(touchIds, [2])
  assert.deepEqual(closeIds, [])
  assert.deepEqual(openJobs, [])
  assert.deepEqual(agedOutIds, [1])
})

test('a paused row absent from the listing is aged out too', () => {
  const { agedOutIds } = partitionJobs([row(1, 100, 'paused', { pause_date: '2026-06-01T00:00:00Z' })], [])
  assert.deepEqual(agedOutIds, [1])
})

// The half that must NOT change: a job we watched reach a terminal state is
// history, and stays is_current once ESI stops reporting it.
test('a terminal row absent from the listing survives', () => {
  for (const status of TERMINAL_STATUSES) {
    const { closeIds, agedOutIds } = partitionJobs([row(1, 100, status)], [])
    assert.deepEqual(agedOutIds, [], `${status} should not age out`)
    assert.deepEqual(closeIds, [], `${status} should not be closed`)
  }
})

test('aging out is independent of whether other jobs are still reported', () => {
  // An empty listing is a legitimate answer (every job delivered and aged out),
  // and must age out every non-terminal row rather than being treated as a
  // failed fetch — partitionJobs is only ever handed a complete listing.
  const { agedOutIds } = partitionJobs([row(1, 100, 'active'), row(2, 200, 'delivered'), row(3, 300, 'active')], [])
  assert.deepEqual(agedOutIds, [1, 3])
})

test('job ids compare across string/number representations', () => {
  // Postgres returns bigints as strings; ESI sends numbers. A mismatch here
  // would age out every row on every run.
  const { touchIds, agedOutIds } = partitionJobs([row(1, '100' as unknown as number, 'active')], [esi(100, 'active')])
  assert.deepEqual(touchIds, [1])
  assert.deepEqual(agedOutIds, [])
})

test('a job reported twice in one listing is collapsed to a single insert', () => {
  const { openJobs } = partitionJobs([], [esi(100, 'active'), esi(100, 'active')])
  assert.equal(openJobs.length, 1)
})

test('signature ignores timestamp serialization differences', () => {
  // Postgres hands back +00:00, ESI sends Z. Comparing the raw strings would
  // churn a new version of every completed job on every run.
  assert.equal(
    jobSignature({ status: 'delivered', completed_date: '2026-08-01T12:00:00+00:00' }),
    jobSignature({ status: 'delivered', completed_date: '2026-08-01T12:00:00Z' })
  )
})

test('signature tracks the fields that advance over a job life', () => {
  assert.notEqual(jobSignature({ status: 'active' }), jobSignature({ status: 'delivered' }))
  assert.notEqual(jobSignature({ status: 'active' }), jobSignature({ status: 'active', pause_date: '2026-08-01Z' }))
  assert.notEqual(
    jobSignature({ status: 'delivered', successful_runs: 9 }),
    jobSignature({ status: 'delivered', successful_runs: 10 })
  )
})
