// The /structure/rebates window: a length, and an optional start day.
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseDay, rebateWindow, rebateWindowHref } from '../src/app/structure/rebates/window.ts'

const NOW = new Date('2026-11-17T03:27:29.000Z')

test('a start day and 30 days is 1 to 30 October', () => {
  assert.deepEqual(rebateWindow({ from: '2026-10-01', days: '30' }, NOW), {
    days: 30,
    from: '2026-10-01',
    since: '2026-10-01T00:00:00.000Z',
    until: '2026-10-31T00:00:00.000Z',
    lastDay: '2026-10-30',
  })
})

test('September is 1 September and 30 days', () => {
  const w = rebateWindow({ from: '2026-09-01', days: '30' }, NOW)
  assert.equal(w.lastDay, '2026-09-30')
})

test('no start day trails back from now', () => {
  assert.deepEqual(rebateWindow({ days: '7' }, NOW), {
    days: 7,
    from: null,
    since: '2026-11-10T03:27:29.000Z',
    until: '2026-11-17T03:27:29.000Z',
    lastDay: '2026-11-17',
  })
})

test('a bad length falls back to 30 days, and a bad day to trailing', () => {
  const w = rebateWindow({ days: '45', from: '2026-02-30' }, NOW)
  assert.equal(w.days, 30)
  assert.equal(w.from, null)
})

test('parseDay takes only a real calendar day', () => {
  assert.equal(parseDay('2026-10-01'), '2026-10-01')
  assert.equal(parseDay('2026-02-30'), null)
  assert.equal(parseDay('2026-10-1'), null)
  assert.equal(parseDay(undefined), null)
})

test('the href keeps both values', () => {
  assert.equal(rebateWindowHref('/p', { days: 30, from: '2026-10-01' }), '/p?from=2026-10-01&days=30')
  assert.equal(rebateWindowHref('/p', { days: 7, from: null }), '/p?days=7')
})
