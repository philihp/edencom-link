// Which version of a ship's memory a page shows (src/app/ship/memory/select.ts):
// the current one on the holder's page, the one in force at the last sighting
// on a dead hull's share link, and the "written N times" count for either.
import assert from 'node:assert/strict'
import test from 'node:test'

import { memoryMeta, type MemoryVersion, versionAsOf } from '../src/app/ship/memory/select.ts'

const v = (over: Partial<MemoryVersion> & Pick<MemoryVersion, 'id' | 'valid_from'>): MemoryVersion => ({
  body: `v${over.id}`,
  author: 'mcp',
  written_by: 'u1',
  is_current: false,
  valid_until: over.valid_from,
  ...over,
})

// Three writes: the seller's two, then the buyer's after the sale on the 10th.
const ROWS = [
  v({ id: 1, valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-10-05T00:00:00Z' }),
  v({ id: 2, valid_from: '2026-10-05T00:00:00Z', valid_until: '2026-10-12T00:00:00Z' }),
  v({ id: 3, valid_from: '2026-10-12T00:00:00Z', is_current: true, written_by: 'u2' }),
]

test('with no asOf, the current version', () => {
  assert.equal(versionAsOf(ROWS, null)?.id, 3)
  assert.equal(versionAsOf(ROWS.slice(0, 2), null), null)
  assert.equal(versionAsOf([], null), null)
})

test('asOf picks the version in force then: opened at or before, not yet closed', () => {
  assert.equal(versionAsOf(ROWS, '2026-10-03T00:00:00Z')?.id, 1)
  // The close instant belongs to the next version.
  assert.equal(versionAsOf(ROWS, '2026-10-05T00:00:00Z')?.id, 2)
  assert.equal(versionAsOf(ROWS, '2026-10-10T00:00:00Z')?.id, 2)
  // After the buyer's write, the open row applies.
  assert.equal(versionAsOf(ROWS, '2026-11-01T00:00:00Z')?.id, 3)
  // Before the first write there was no memory.
  assert.equal(versionAsOf(ROWS, '2026-09-01T00:00:00Z'), null)
})

test('an open row is not consulted on its valid_until, which is only its debut', () => {
  const rows = [v({ id: 9, valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-10-01T00:00:00Z', is_current: true })]
  assert.equal(versionAsOf(rows, '2026-10-20T00:00:00Z')?.id, 9)
})

test('memoryMeta counts the writes up to the version shown', () => {
  assert.deepEqual(memoryMeta(ROWS, ROWS[2]), { versions: 3, lastWritten: '2026-10-12T00:00:00Z' })
  // On the seller's old link, the buyer's later write is not counted.
  assert.deepEqual(memoryMeta(ROWS, ROWS[1]), { versions: 2, lastWritten: '2026-10-05T00:00:00Z' })
})
