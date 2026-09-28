// The Impersonate box accepts a user id or a character name; this is the
// reading of what was typed and of what a name lookup returned.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ownerOfMatches, parseImpersonationTarget } from '../src/app/account/settings/chancellor/impersonationTarget.ts'

test('a uuid is a user id, whatever its case or padding', () => {
  assert.deepEqual(parseImpersonationTarget('  A0000000-0000-4000-8000-000000000001 '), {
    kind: 'user',
    userId: 'a0000000-0000-4000-8000-000000000001',
  })
})

test('anything else is a character name, with its spacing tidied', () => {
  assert.deepEqual(parseImpersonationTarget('  Sir   Cuddles '), { kind: 'character', name: 'Sir Cuddles' })
  assert.deepEqual(parseImpersonationTarget('Quuixote'), { kind: 'character', name: 'Quuixote' })
})

test('a uuid missing a group is a name, not a user id', () => {
  assert.equal(parseImpersonationTarget('a0000000-0000-4000-8000').kind, 'character')
})

test('blank input is empty', () => {
  assert.deepEqual(parseImpersonationTarget('   '), { kind: 'empty' })
})

test('one owner among the matches is the answer, however many rows carry it', () => {
  assert.deepEqual(ownerOfMatches([{ user_id: 'u1' }, { user_id: 'u1' }]), { ok: true, userId: 'u1' })
})

test('no match, and two owners, are refusals', () => {
  assert.deepEqual(ownerOfMatches([]), { ok: false, reason: 'none' })
  assert.deepEqual(ownerOfMatches([{ user_id: null }]), { ok: false, reason: 'none' })
  assert.deepEqual(ownerOfMatches([{ user_id: 'u1' }, { user_id: 'u2' }]), { ok: false, reason: 'ambiguous' })
})
