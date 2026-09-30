// On-demand refresh coalescing: what a recent task still covers, how tasks
// are keyed, and which characters stand for a corporation.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  coalesce,
  corpRepresentatives,
  IN_FLIGHT_MAX_AGE_MS,
  RECENT_WINDOW_MS,
  stillCovers,
  taskKey,
} from '../src/app/character/refreshCoalesce.ts'

const NOW = Date.parse('2026-09-30T03:02:59Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

test('taskKey names the corporation for a corp job, the character otherwise, the account for neither', () => {
  assert.equal(
    taskKey({ job: 'corp-assets', registrationId: 'r1', corporationId: 98001, corpScoped: true }),
    'corp-assets:corp:98001'
  )
  assert.equal(
    taskKey({ job: 'corp-assets', registrationId: 'r1', corporationId: null, corpScoped: true }),
    'corp-assets:r1'
  )
  assert.equal(
    taskKey({ job: 'character-assets', registrationId: 'r1', corporationId: 98001, corpScoped: false }),
    'character-assets:r1'
  )
  assert.equal(taskKey({ job: 'universe-names', registrationId: null, corpScoped: false }), 'universe-names:account')
})

test('a task done in the last ten minutes still covers; an older one does not', () => {
  assert.equal(stillCovers({ key: 'k', status: 'done', createdAt: ago(RECENT_WINDOW_MS - 1) }, NOW), true)
  assert.equal(stillCovers({ key: 'k', status: 'error', createdAt: ago(RECENT_WINDOW_MS - 1) }, NOW), true)
  assert.equal(stillCovers({ key: 'k', status: 'done', createdAt: ago(RECENT_WINDOW_MS + 1) }, NOW), false)
})

test('a task in flight covers for an hour, then counts as stuck', () => {
  assert.equal(stillCovers({ key: 'k', status: 'running', createdAt: ago(IN_FLIGHT_MAX_AGE_MS - 1) }, NOW), true)
  assert.equal(stillCovers({ key: 'k', status: 'pending', createdAt: ago(IN_FLIGHT_MAX_AGE_MS + 1) }, NOW), false)
})

test('an unreadable timestamp never covers', () => {
  assert.equal(stillCovers({ key: 'k', status: 'done', createdAt: 'yesterday' }, NOW), false)
})

test('coalesce keeps what nothing recent covers, and a repeated key once', () => {
  const tasks = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'b' }]
  const recent = [
    { key: 'a', status: 'done', createdAt: ago(60_000) },
    { key: 'c', status: 'done', createdAt: ago(RECENT_WINDOW_MS + 60_000) },
  ]
  const { kept, skipped } = coalesce(tasks, recent, NOW)
  assert.deepEqual(
    kept.map((t) => t.key),
    ['b', 'c']
  )
  assert.deepEqual(
    skipped.map((t) => t.key),
    ['a', 'b']
  )
})

test('corpRepresentatives keeps one character per corporation the batch introduces', () => {
  const batch = [
    { id: 'a', corporationId: 1 },
    { id: 'b', corporationId: 1 },
    { id: 'c', corporationId: 2 },
    { id: 'd', corporationId: null },
  ]
  assert.deepEqual(
    corpRepresentatives(batch, batch).map((c) => c.id),
    ['a', 'c', 'd']
  )
})

test('a corporation the account already tracks through another character gets no representative', () => {
  const batch = [{ id: 'new', corporationId: 1 }]
  const account = [
    { id: 'old', corporationId: 1 },
    { id: 'new', corporationId: 1 },
  ]
  assert.deepEqual(corpRepresentatives(batch, account), [])
})

test('refresh everything passes every character, so every corporation keeps one', () => {
  const account = [
    { id: 'a', corporationId: 1 },
    { id: 'b', corporationId: 1 },
    { id: 'c', corporationId: 2 },
  ]
  assert.deepEqual(
    corpRepresentatives(account, account).map((c) => c.id),
    ['a', 'c']
  )
})
