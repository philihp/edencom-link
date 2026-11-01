// The pure seams of recall_ship (src/app/api/mcp/memoryQuery.ts): which hull
// a name picks out, how far a share row reaches, and whether the memory came
// before the caller's time.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeReader,
  EXTRACT_INTERVAL_MS,
  inheritance,
  parseItemId,
  pickHull,
  subjectOf,
} from '../src/app/api/mcp/memoryQuery.ts'

test('an item id is a run of digits; anything else is a name', () => {
  assert.equal(parseItemId('1041234567890'), 1041234567890)
  assert.equal(parseItemId(' 1041234567890 '), 1041234567890)
  assert.equal(parseItemId('Rusty Kettle'), null)
  assert.equal(parseItemId('42'), null) // too short to be an item id; a ship named "42"
})

test('pickHull: the newest version per item, dead hulls marked, ambiguity refused', () => {
  const rows = [
    { item_id: 1, name: 'Rusty Kettle', type_id: 653, is_current: false, valid_until: '2026-01-01T00:00:00Z' },
    { item_id: 1, name: 'Rusty Kettle', type_id: 653, is_current: true, valid_until: '2026-02-01T00:00:00Z' },
    { item_id: 2, name: 'Rusty Kettle II', type_id: 653, is_current: false, valid_until: '2026-03-01T00:00:00Z' },
    { item_id: 3, name: null, type_id: 653, is_current: true, valid_until: '2026-03-01T00:00:00Z' },
  ]
  assert.deepEqual(pickHull('Rusty Kettle', rows), { ok: true, id: '1' })
  assert.deepEqual(pickHull('Kettle II', rows), { ok: true, id: '2' })
  const both = pickHull('Kettle', rows)
  assert.equal(both.ok, false)
  if (!both.ok) assert.match(both.message, /Rusty Kettle II \(no longer held\)/)
  assert.deepEqual(pickHull('2', rows), { ok: true, id: '2' })
})

test('describeReader: public when a row names no one and has no secret', () => {
  const row = { item_id: 1, corporation_ids: [], alliance_ids: [], secret: null }
  assert.equal(describeReader(row, 'ship').reach, 'everyone')
  assert.equal(describeReader(row, 'ship').by_link, false)
})

test('describeReader: audiences compose with a link, and show_as_main is carried', () => {
  const r = describeReader(
    { item_id: 1, corporation_ids: ['98000001'], alliance_ids: [], secret: 's3cret', show_as_main: true },
    'container'
  )
  assert.equal(r.reach, 'corporations_and_alliances')
  assert.deepEqual(r.corporation_ids, [98000001])
  assert.equal(r.by_link, true)
  assert.equal(r.hides_holder, true)
  assert.equal(r.subject, 'container')
  const linkOnly = describeReader({ item_id: 1, corporation_ids: [], alliance_ids: [], secret: 's' }, 'place')
  assert.equal(linkOnly.reach, 'link_holders')
})

test('subjectOf: the hull, a container above it, its place, or nothing', () => {
  assert.equal(subjectOf(10, 10, [20, 30], 60004588), 'ship')
  assert.equal(subjectOf('30', 10, [20, 30], 60004588), 'container')
  assert.equal(subjectOf(60004588, 10, [20, 30], 60004588), 'place')
  assert.equal(subjectOf(99, 10, [20, 30], 60004588), null)
  assert.equal(subjectOf(60004588, 10, [], null), null)
})

test('inheritance: a text by another account is inherited; one by the caller is theirs', () => {
  const mine = inheritance({ written_by: 'u1', valid_from: '2026-02-01T00:00:00Z' }, [], '2026-01-01T00:00:00Z', 'u1')
  assert.equal(mine.inherited, false)
  assert.equal(mine.written_by_you, true)
  const theirs = inheritance({ written_by: 'u2', valid_from: '2026-02-01T00:00:00Z' }, [], '2026-01-01T00:00:00Z', 'u1')
  assert.equal(theirs.inherited, true)
  // A version by a deleted account (written_by null) is still not the caller's.
  assert.equal(
    inheritance({ written_by: null, valid_from: '2026-02-01T00:00:00Z' }, [], '2026-01-01T00:00:00Z', 'u1').inherited,
    true
  )
  assert.equal(inheritance(null, [], '2026-01-01T00:00:00Z', 'u1').inherited, false)
})

test('inheritance: chapters before the caller’s record when the earliest visible write precedes their first sighting', () => {
  const versions = [
    { written_by: 'u2', valid_from: '2025-12-01T00:00:00Z' },
    { written_by: 'u1', valid_from: '2026-02-01T00:00:00Z' },
  ]
  const r = inheritance(versions[1], versions, '2026-01-01T00:00:00Z', 'u1')
  assert.equal(r.predates_your_record, true)
  assert.equal(r.memory_first_written, '2025-12-01T00:00:00Z')
  assert.equal(inheritance(versions[1], [versions[1]], '2026-01-01T00:00:00Z', 'u1').predates_your_record, false)
})

test('the extract intervals are the cron cadence: 6h for a character, a day for a corporation', () => {
  assert.equal(EXTRACT_INTERVAL_MS.character, 6 * 60 * 60 * 1000)
  assert.equal(EXTRACT_INTERVAL_MS.corporation, 24 * 60 * 60 * 1000)
})
