// Unit coverage for the marshalled-fit handle (src/app/api/fittings/
// marshalledHandle.ts): the content hash as a path segment, and the route
// built from it. Small, but the shape test is what keeps a fitting id or a
// restore key from ever being looked up as a hash.
import assert from 'node:assert/strict'
import test from 'node:test'

import { contentHash } from '../src/fittingArchive.ts'
import { marshalledRoute, parseMarshalledHandle } from '../src/app/api/fittings/marshalledHandle.ts'

const hash = contentHash({ name: 'Doctrine Cane', description: '', ship_type_id: 24702, items: [] })

test('a real content hash parses to itself', () => {
  assert.equal(hash.length, 64)
  assert.equal(parseMarshalledHandle(hash), hash)
})

test('upper-case hex is accepted and lower-cased', () => {
  assert.equal(parseMarshalledHandle(hash.toUpperCase()), hash)
})

test('the other two /api/fittings handles are not hashes', () => {
  // A fitting id (digits) and a restore key (uuid) name other things.
  assert.equal(parseMarshalledHandle('42'), null)
  assert.equal(parseMarshalledHandle('22222222-2222-2222-2222-222222222222'), null)
  // Near misses: wrong length, non-hex.
  assert.equal(parseMarshalledHandle(hash.slice(1)), null)
  assert.equal(parseMarshalledHandle(`${hash}0`), null)
  assert.equal(parseMarshalledHandle(`g${hash.slice(1)}`), null)
  assert.equal(parseMarshalledHandle(''), null)
})

test('marshalledRoute is the one-segment path under /fitting/marshalled', () => {
  assert.equal(marshalledRoute(hash), `/fitting/marshalled/${hash}`)
})
