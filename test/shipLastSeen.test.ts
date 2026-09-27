// The share page's last-known state: when a ship counts as overdue, how the
// sighting reads, and which version of each item a snapshot keeps.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isOverdue,
  latestPerItem,
  OVERDUE_AFTER_MS,
  sightingOf,
  sightingText,
} from '../src/app/ship/[itemId]/lastSeen.ts'

const NOW = new Date('2026-09-27T12:00:00Z').getTime()
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const HOUR = 60 * 60 * 1000

test('a ship seen within the day is not overdue, in the hangar or not', () => {
  assert.equal(isOverdue({ lastSeen: at(HOUR), inHangar: true }, NOW), false)
  assert.equal(isOverdue({ lastSeen: at(23 * HOUR), inHangar: false }, NOW), false)
})

test('a ship not seen for over a day is overdue, even while its row is open', () => {
  assert.equal(isOverdue({ lastSeen: at(OVERDUE_AFTER_MS + 1), inHangar: true }, NOW), true)
  assert.equal(isOverdue({ lastSeen: at(3 * 24 * HOUR), inHangar: false }, NOW), true)
})

test('exactly a day is the edge: not yet overdue', () => {
  assert.equal(isOverdue({ lastSeen: at(OVERDUE_AFTER_MS), inHangar: true }, NOW), false)
})

test('sightingText reads like the freshness dot', () => {
  assert.equal(sightingText({ lastSeen: at(3 * HOUR), inHangar: true }, NOW), 'last seen 3 hours ago')
  assert.equal(sightingText({ lastSeen: at(2 * 24 * HOUR), inHangar: false }, NOW), 'last seen 2 days ago')
})

test('sightingOf takes the last look from the row and whether it is open', () => {
  assert.deepEqual(sightingOf({ is_current: false, valid_until: '2026-09-24T06:00:00+00:00' }), {
    lastSeen: '2026-09-24T06:00:00+00:00',
    inHangar: false,
  })
})

test('latestPerItem keeps the newest version of each item', () => {
  const rows = [
    { item_id: 1, is_current: false, valid_until: at(2 * HOUR), name: 'old' },
    { item_id: 1, is_current: false, valid_until: at(HOUR), name: 'new' },
    { item_id: 2, is_current: false, valid_until: at(HOUR), name: 'only' },
  ]
  assert.deepEqual(
    latestPerItem(rows)
      .map((row) => `${row.item_id}:${row.name}`)
      .sort(),
    ['1:new', '2:only']
  )
})

test('latestPerItem prefers an open row over a closed one with a later stamp', () => {
  const rows = [
    { item_id: '7', is_current: false, valid_until: at(0), name: 'closed' },
    { item_id: 7, is_current: true, valid_until: at(HOUR), name: 'open' },
  ]
  assert.deepEqual(
    latestPerItem(rows).map((row) => row.name),
    ['open']
  )
})

test('latestPerItem of nothing is nothing', () => {
  assert.deepEqual(latestPerItem([]), [])
})
