// Unit coverage for the truncated-lens-id seam (src/app/lens/uuidPrefix.ts).
// What's worth pinning: a prefix expands to the exact uuid range that a
// bytewise (= hex-string-wise) comparison scans, only canonical-format
// prefixes qualify, and the 8-hex-digit floor holds.
import assert from 'node:assert/strict'
import test from 'node:test'

import { shortestUuidPrefix, uuidPrefixRange } from '../src/app/lens/uuidPrefix.ts'

test('a bare first group pads to the full range', () => {
  assert.deepEqual(uuidPrefixRange('da204490'), {
    low: 'da204490-0000-0000-0000-000000000000',
    high: 'da204490-ffff-ffff-ffff-ffffffffffff',
  })
})

test('a longer prefix keeps its dashes and pads the rest', () => {
  assert.deepEqual(uuidPrefixRange('da204490-4d2'), {
    low: 'da204490-4d20-0000-0000-000000000000',
    high: 'da204490-4d2f-ffff-ffff-ffffffffffff',
  })
  // A trailing dash is a legitimate string prefix of the canonical form.
  assert.deepEqual(uuidPrefixRange('da204490-'), {
    low: 'da204490-0000-0000-0000-000000000000',
    high: 'da204490-ffff-ffff-ffff-ffffffffffff',
  })
})

test('uppercase input lowercases into the range', () => {
  assert.deepEqual(uuidPrefixRange('DA204490'), {
    low: 'da204490-0000-0000-0000-000000000000',
    high: 'da204490-ffff-ffff-ffff-ffffffffffff',
  })
})

test('a full uuid is its own single-point range', () => {
  const full = 'da204490-4d28-41d8-a452-95aabcb65209'
  assert.deepEqual(uuidPrefixRange(full), { low: full, high: full })
})

test('fewer than 8 hex digits is rejected', () => {
  assert.equal(uuidPrefixRange('da20449'), null)
  assert.equal(uuidPrefixRange(''), null)
})

test('non-canonical shapes are rejected', () => {
  // Hex where the canonical form has a dash.
  assert.equal(uuidPrefixRange('da2044904d28'), null)
  // A dash where the canonical form has hex.
  assert.equal(uuidPrefixRange('da2044-90'), null)
  // Non-hex characters, and anything longer than a uuid.
  assert.equal(uuidPrefixRange('da2044zz'), null)
  assert.equal(uuidPrefixRange('da204490-4d28-41d8-a452-95aabcb652090'), null)
})

// The emit side: the shortest prefix that still resolves back to the id,
// given the ids it has to beat. Every emitted prefix must round-trip through
// uuidPrefixRange — a short link the resolver rejects would be worse than a
// long one.
const ID = 'da204490-4d28-41d8-a452-95aabcb65209'

test('an uncontested id shortens to its first group', () => {
  const short = shortestUuidPrefix(ID, [])
  assert.equal(short, 'da204490')
  assert.notEqual(uuidPrefixRange(short), null)
})

test('a contested prefix extends only as far as the first differing digit', () => {
  // Shares 8 digits with ID, differs at the 9th.
  assert.equal(shortestUuidPrefix(ID, ['da204490-ffff-ffff-ffff-ffffffffffff']), 'da204490-4')
  // Shares 12 digits, so the dash is crossed and the 13th digit decides.
  const short = shortestUuidPrefix(ID, ['da204490-4d28-ffff-ffff-ffffffffffff'])
  assert.equal(short, 'da204490-4d28-4')
  assert.notEqual(uuidPrefixRange(short), null)
})

test('several contenders each push the prefix as far as the closest one', () => {
  const contested = ['da204490-ffff-ffff-ffff-ffffffffffff', 'da204490-4d28-41d8-ffff-ffffffffffff']
  assert.equal(shortestUuidPrefix(ID, contested), 'da204490-4d28-41d8-a')
})

test('only the full id disambiguates from an all-but-identical contender', () => {
  assert.equal(shortestUuidPrefix(ID, ['da204490-4d28-41d8-a452-95aabcb65200']), ID)
})

test('a self-match in the contested set falls back to the full id', () => {
  assert.equal(shortestUuidPrefix(ID, [ID]), ID)
})
