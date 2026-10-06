// The /industry window dropdown: the range a window stands for, how a saved
// choice reads back, and which jobs the list shows for a window.
import assert from 'node:assert/strict'
import test from 'node:test'

import { jobsListedInWindow, type LiftJob } from '../src/app/industry/lift.ts'
import {
  DEFAULT_INDUSTRY_WINDOW_DAYS,
  INDUSTRY_WINDOW_OPTIONS,
  isIndustryWindowDays,
  parseIndustryWindowDays,
  windowRange,
} from '../src/app/industry/windows.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-06T12:00:00Z')

test('the default window is one of the offered options', () => {
  assert.ok(isIndustryWindowDays(DEFAULT_INDUSTRY_WINDOW_DAYS))
  assert.ok(INDUSTRY_WINDOW_OPTIONS.every((o) => isIndustryWindowDays(o.days)))
})

test('a window runs the trailing days up to now, with a short projection ahead', () => {
  assert.deepEqual(windowRange(30, NOW), { t0: NOW - 30 * DAY, t1: NOW + 2 * DAY })
  assert.deepEqual(windowRange(90, NOW), { t0: NOW - 90 * DAY, t1: NOW + 2 * DAY })
})

test('a short window is not mostly future: the projection is capped at a seventh of it', () => {
  const { t0, t1 } = windowRange(1, NOW)
  assert.equal(t0, NOW - DAY)
  assert.equal(t1 - NOW, Math.round(DAY / 7))
  assert.equal(windowRange(7, NOW).t1 - NOW, DAY)
})

test('a saved choice reads back only when it is an offered option', () => {
  assert.equal(parseIndustryWindowDays('7'), 7)
  assert.equal(parseIndustryWindowDays('56'), undefined)
  assert.equal(parseIndustryWindowDays('seven'), undefined)
  assert.equal(parseIndustryWindowDays(null), undefined)
  assert.equal(parseIndustryWindowDays(undefined), undefined)
})

const job = (
  id: string,
  status: string,
  start: number,
  end: number,
  family: LiftJob['family'] = 'manufacturing'
): LiftJob => ({
  id,
  ownerId: 'o',
  family,
  activityId: family === 'manufacturing' ? 1 : family === 'reaction' ? 9 : 3,
  productTypeId: null,
  blueprintTypeId: 1,
  runs: 1,
  status,
  start,
  end,
  stationId: null,
  lift: null,
  rate: null,
})

test('the window list holds every job that ran in the window, open first then most recently finished', () => {
  const jobs = [
    job('old', 'delivered', NOW - 20 * DAY, NOW - 15 * DAY),
    job('recent', 'delivered', NOW - 3 * DAY, NOW - DAY),
    job('research', 'active', NOW - 2 * DAY, NOW + 5 * DAY, 'research'),
    job('soon', 'active', NOW - HOUR, NOW + HOUR),
    job('ancient', 'delivered', NOW - 60 * DAY, NOW - 40 * DAY),
    job('queued', 'active', NOW + DAY, NOW + 1.5 * DAY),
    job('beyond', 'active', NOW + 3 * DAY, NOW + 4 * DAY),
  ]
  const { t0, t1 } = windowRange(30, NOW)
  assert.deepEqual(
    jobsListedInWindow(jobs, t0, t1).map((j) => j.id),
    ['soon', 'queued', 'research', 'recent', 'old']
  )
})

test('a job that ended exactly at the window start, or starts at its end, is not in it', () => {
  const { t0, t1 } = windowRange(7, NOW)
  const jobs = [job('edge-before', 'delivered', t0 - DAY, t0), job('edge-after', 'active', t1, t1 + DAY)]
  assert.deepEqual(jobsListedInWindow(jobs, t0, t1), [])
})
