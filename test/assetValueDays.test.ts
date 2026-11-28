import assert from 'node:assert/strict'
import { test } from 'node:test'

import { daysBetween, halve, pendingRuns } from '../src/jobs/assetValueDays.js'

test('daysBetween lists every day, inclusive', () => {
  assert.deepEqual(daysBetween('2026-11-28', '2026-12-01'), ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'])
  assert.deepEqual(daysBetween('2026-11-28', '2026-11-27'), [])
})

test('pendingRuns chunks the days when none are done', () => {
  assert.deepEqual(pendingRuns('2026-11-01', '2026-11-05', [], 2), [
    ['2026-11-01', '2026-11-02'],
    ['2026-11-03', '2026-11-04'],
    ['2026-11-05'],
  ])
})

test('pendingRuns skips the days already done and never spans one', () => {
  assert.deepEqual(pendingRuns('2026-11-01', '2026-11-06', ['2026-11-02', '2026-11-03'], 3), [
    ['2026-11-01'],
    ['2026-11-04', '2026-11-05', '2026-11-06'],
  ])
})

test('pendingRuns is empty when every day is done', () => {
  assert.deepEqual(pendingRuns('2026-11-01', '2026-11-02', ['2026-11-01', '2026-11-02'], 3), [])
})

test('halve splits a run, the first half the longer', () => {
  assert.deepEqual(halve(['a', 'b', 'c']), [['a', 'b'], ['c']])
  assert.deepEqual(halve(['a']), [['a'], []])
})
