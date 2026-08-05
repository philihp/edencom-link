// Unit coverage for the share-link signing seam (src/shareToken.ts). What's
// worth pinning: the signature is deterministic for a (shareId, secret, salt)
// triple and changes when ANY of the three changes — the salt being live in
// the signature is the whole point of TOKEN_SALT (a database dump alone must
// not mint valid links).
import assert from 'node:assert/strict'
import test from 'node:test'

import { mintShareSecret, signShare, verifyShareToken } from '../src/shareToken.ts'

const SECRET = 'a'.repeat(64)
const SALT = 'test-salt'

test('signing is deterministic and url-safe', () => {
  const token = signShare('share-1', SECRET, SALT)
  assert.equal(token, signShare('share-1', SECRET, SALT))
  assert.match(token, /^[A-Za-z0-9_-]+$/)
})

test('a valid signature verifies; any changed input fails', () => {
  const token = signShare('share-1', SECRET, SALT)
  assert.equal(verifyShareToken('share-1', SECRET, SALT, token), true)
  assert.equal(verifyShareToken('share-2', SECRET, SALT, token), false)
  assert.equal(verifyShareToken('share-1', 'b'.repeat(64), SALT, token), false)
  assert.equal(verifyShareToken('share-1', SECRET, 'other-salt', token), false)
})

test('malformed presented tokens fail without throwing', () => {
  assert.equal(verifyShareToken('share-1', SECRET, SALT, ''), false)
  assert.equal(verifyShareToken('share-1', SECRET, SALT, 'short'), false)
  assert.equal(verifyShareToken('share-1', SECRET, SALT, 'x'.repeat(300)), false)
})

test('minted secrets are 32 random bytes, hex, and unique', () => {
  const one = mintShareSecret()
  assert.match(one, /^[0-9a-f]{64}$/)
  assert.notEqual(one, mintShareSecret())
})
