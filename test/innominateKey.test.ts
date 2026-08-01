// Unit coverage for the appraisal request key (src/innominateKey.ts).
//
// What's worth pinning here is the property whose absence broke production:
// the key is the innominate_appraisal primary key AND the queue's
// Vqs-Idempotency-Key header, so it has to stay a fixed, small width no matter
// how many item lines go into the request. It used to be the serialized item
// list, which grew past both limits on a real hangar — and only on a big one,
// so /api/appraisal returned 502 for some targets and 200 for others.
import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalRequest, requestKeyFor, type KeyItem } from '../src/innominateKey.ts'

const items = (n: number): KeyItem[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Some Reasonably Long Item Name ${i}`, quantity: 1000 + i }))

// A btree index row caps at 2704 bytes; the header limit is lower still. 64 hex
// characters leaves both untouched at any batch size.
const SHA256_HEX = 64

test('the key is fixed-width regardless of how many items it describes', () => {
  for (const n of [1, 10, 100, 500, 5000]) {
    const key = requestKeyFor(items(n), 'jita')
    assert.equal(key.length, SHA256_HEX, `${n} items should still key to ${SHA256_HEX} chars`)
    assert.match(key, /^[0-9a-f]+$/, 'the key should be plain lowercase hex, safe in a header and a text PK')
  }
})

test('the key stays far under the btree index-row limit that broke the upsert', () => {
  // The regression in one assertion: the old key was the canonical JSON itself,
  // which blows past 2704 bytes long before 500 lines.
  const big = items(500)
  assert.ok(Buffer.byteLength(canonicalRequest(big, 'jita')) > 2704, 'the canonical form is the thing that got too big')
  assert.ok(Buffer.byteLength(requestKeyFor(big, 'jita')) < 100, 'the key derived from it must not be')
})

test('input order does not change the key, so a cache entry is shared', () => {
  const forward = items(25)
  const reversed = [...forward].reverse()
  assert.equal(requestKeyFor(forward, 'jita'), requestKeyFor(reversed, 'jita'))
})

test('market and quantity are part of the identity', () => {
  const base = items(3)
  assert.notEqual(requestKeyFor(base, 'jita'), requestKeyFor(base, 'amarr'), 'a different hub is a different price')
  const moved = [{ ...base[0], quantity: base[0].quantity + 1 }, ...base.slice(1)]
  assert.notEqual(requestKeyFor(base, 'jita'), requestKeyFor(moved, 'jita'), 'a different amount is a different total')
})

test('the same request keys identically across calls', () => {
  assert.equal(requestKeyFor(items(40), 'jita'), requestKeyFor(items(40), 'jita'))
})
