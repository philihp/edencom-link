// Unit coverage for the marshalled library entry (src/app/fitting/marshal/
// entry.ts): the href every marshalled fit on /fitting links to, the sentinel
// owner the filter selects on, and the label fallback.
import assert from 'node:assert/strict'
import test from 'node:test'

import { MARSHALLED_OWNER, marshalledEntry } from '../src/app/fitting/marshal/entry.ts'

const hash = 'a'.repeat(64)

test('a marshalled row becomes a dimmed entry under the archive owner', () => {
  assert.deepEqual(marshalledEntry({ content_hash: hash, name: 'Doctrine Cane', ship_type_id: '24702' }), {
    href: `/fitting/marshalled/${hash}`,
    name: 'Doctrine Cane',
    shipTypeId: 24702,
    ownerId: MARSHALLED_OWNER,
    marshalled: true,
  })
})

test('a nameless fit still has a label', () => {
  assert.equal(marshalledEntry({ content_hash: hash, name: null, ship_type_id: 587 }).name, 'Unnamed fitting')
  assert.equal(marshalledEntry({ content_hash: hash, name: '', ship_type_id: 587 }).name, 'Unnamed fitting')
})

test('the sentinel owner can never be an EVE id', () => {
  // Owner ids in the filter are digit strings; a word stays distinct.
  assert.equal(/^\d+$/.test(MARSHALLED_OWNER), false)
  assert.notEqual(MARSHALLED_OWNER, '')
})
