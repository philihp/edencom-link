// Unit coverage for the reductions behind /jobs (docs/jobs-page.md): the two
// ends of the run range the page reports at once ("is my data fresh" vs "did
// the schedule fire"), the lagging-character note, and the first-match-wins
// status precedence that decides whether a cell reads running, queued, failed
// or just stale.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type EntityRun,
  activityRows,
  isAbandoned,
  laggingCount,
  newestRun,
  oldestRun,
  rowStatus,
  statusOf,
} from '../src/app/jobs/rows.ts'

const NOW = Date.parse('2026-08-12T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const run = (over: Partial<EntityRun> = {}): EntityRun => ({
  id: 'r1',
  name: 'Philihp Boeing',
  lastRunAt: minutesAgo(5),
  status: 'idle',
  error: null,
  ...over,
})

test('the headline run is the oldest entity, the overdue check the newest', () => {
  const entities = [
    run({ id: 'a', lastRunAt: minutesAgo(5) }),
    run({ id: 'b', lastRunAt: minutesAgo(600) }),
    run({ id: 'c', lastRunAt: minutesAgo(90) }),
  ]
  assert.equal(oldestRun(entities), minutesAgo(600))
  assert.equal(newestRun(entities), minutesAgo(5))
})

test('a character that has never run makes the row never, but not the schedule broken', () => {
  const entities = [run({ id: 'a', lastRunAt: minutesAgo(5) }), run({ id: 'b', lastRunAt: null })]
  // Nothing is older than not having happened...
  assert.equal(oldestRun(entities), null)
  // ...but the cron plainly did fire, so the overdue input is unaffected.
  assert.equal(newestRun(entities), minutesAgo(5))
})

test('no entities at all reads as never rather than as fresh', () => {
  assert.equal(oldestRun([]), null)
  assert.equal(newestRun([]), null)
  assert.equal(laggingCount([]), 0)
})

test('lagging counts entities behind the best-off one, not entities that are merely stale', () => {
  // All three equally stale for a six-hourly job: the normal state most of the
  // day, and nothing worth flagging.
  const evenlyStale = [
    run({ id: 'a', lastRunAt: minutesAgo(300) }),
    run({ id: 'b', lastRunAt: minutesAgo(310) }),
    run({ id: 'c', lastRunAt: minutesAgo(320) }),
  ]
  assert.equal(laggingCount(evenlyStale, NOW), 0)

  // One character a grade behind the others — a dead token or a missing scope.
  const oneBehind = [
    run({ id: 'a', lastRunAt: minutesAgo(5) }),
    run({ id: 'b', lastRunAt: minutesAgo(5) }),
    run({ id: 'c', lastRunAt: minutesAgo(700) }),
  ]
  assert.equal(laggingCount(oneBehind, NOW), 1)

  // Never-run is its own (worst) grade.
  assert.equal(laggingCount([run({ id: 'a' }), run({ id: 'b', lastRunAt: null })], NOW), 1)
})

test('status precedence: in flight beats queued beats failed', () => {
  assert.equal(rowStatus([run({ status: 'failed' }), run({ status: 'running' }), run({ status: 'queued' })]), 'running')
  assert.equal(rowStatus([run({ status: 'failed' }), run({ status: 'queued' })]), 'queued')
  assert.equal(rowStatus([run({ status: 'failed' }), run({ status: 'idle' })]), 'failed')
  assert.equal(rowStatus([run(), run()]), 'idle')
})

test('a scheduled run is visible as running through its open heartbeat', () => {
  // The case latest_heartbeats() can't see: no task of the caller's, but a
  // heartbeat that started and hasn't ended.
  assert.deepEqual(statusOf({ open: true }), { status: 'running', error: null })
  assert.deepEqual(statusOf({ task: { status: 'pending', error: null } }), { status: 'queued', error: null })
  // A kicked task that's already running outranks its own stale heartbeat.
  assert.deepEqual(statusOf({ task: { status: 'running', error: null }, beat: { ok: false, error: 'boom' } }), {
    status: 'running',
    error: null,
  })
})

test('a failed scheduled run reads as failed, an unknown outcome does not', () => {
  assert.deepEqual(statusOf({ beat: { ok: false, error: '403 Forbidden' } }), {
    status: 'failed',
    error: '403 Forbidden',
  })
  assert.deepEqual(statusOf({ beat: { ok: true, error: null } }), { status: 'idle', error: null })
  // Rows predating heartbeat.ok, and CLI runs, carry no outcome — an unknown
  // one must not be rendered as a failure.
  assert.deepEqual(statusOf({ beat: { ok: null, error: null } }), { status: 'idle', error: null })
  assert.deepEqual(statusOf({}), { status: 'idle', error: null })
})

const task = (over: Partial<Parameters<typeof activityRows>[0][number]> = {}) => ({
  id: 't1',
  batch_id: 'b1',
  job: 'character-assets',
  character_name: 'Philihp Boeing',
  status: 'done',
  error: null,
  created_at: minutesAgo(30),
  started_at: minutesAgo(30),
  ended_at: minutesAgo(29),
  ...over,
})

test('activity is newest first, timed once per batch, with a duration', () => {
  const rows = activityRows([
    task({ id: 'old', batch_id: 'b0', created_at: minutesAgo(300) }),
    task({ id: 'a', batch_id: 'b1', job: 'character-assets' }),
    task({ id: 'b', batch_id: 'b1', job: 'character-blueprints' }),
  ])
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'b', 'old']
  )
  assert.deepEqual(
    rows.map((r) => r.firstOfBatch),
    [true, false, true]
  )
  assert.equal(rows[0].durationSeconds, 60)
  // Still running: no end, so no duration rather than a fake zero.
  assert.equal(activityRows([task({ status: 'running', ended_at: null })])[0].durationSeconds, null)
})

test('a task stuck non-terminal is abandoned, a terminal one never is', () => {
  assert.equal(isAbandoned(task({ status: 'running', created_at: minutesAgo(90), ended_at: null }), NOW), true)
  assert.equal(isAbandoned(task({ status: 'pending', created_at: minutesAgo(5), ended_at: null }), NOW), false)
  assert.equal(isAbandoned(task({ status: 'error', created_at: minutesAgo(600) }), NOW), false)
  assert.equal(isAbandoned(task({ status: 'done', created_at: minutesAgo(600) }), NOW), false)
})
