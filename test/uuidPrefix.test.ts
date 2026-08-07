// Unit coverage for the truncated-lens-id seam (src/app/lens/uuidPrefix.ts).
// What's worth pinning: a prefix expands to the exact uuid range that a
// bytewise (= hex-string-wise) comparison scans, only canonical-format
// prefixes qualify, and the 8-hex-digit floor holds.
import assert from 'node:assert/strict'
import test from 'node:test'

import { uuidPrefixRange } from '../src/app/lens/uuidPrefix.ts'

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
