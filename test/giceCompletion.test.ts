// Which account a verified GICE identity lands on (docs/open-registration.md,
// stage 4). GICE was the last way in that still demanded an invite code; what
// replaced the gate is this three-way decision, and each branch is a different
// way of getting an account wrong: minting a second one for somebody who is
// already holding one, linking an identity that belongs to another account, or
// refusing to mint at all when there is nothing to link to.
import assert from 'node:assert/strict'
import test from 'node:test'

import { giceCompletionPlan } from '../src/app/account/lib/signupFlow.ts'

const caller = { userId: 'caller' }

test('a caller with no session at all has the account minted for them', () => {
  assert.equal(giceCompletionPlan({ caller: null, existingLinkUserId: null }), 'create')
})

test('a caller holding a session has GICE linked onto it, in place', () => {
  assert.equal(giceCompletionPlan({ caller, existingLinkUserId: null }), 'link-in-place')
})

test('re-finishing a registration that already linked this identity is not a second account', () => {
  assert.equal(giceCompletionPlan({ caller, existingLinkUserId: 'caller' }), 'link-in-place')
})

test('an identity already linked elsewhere signs the caller into that account', () => {
  assert.equal(giceCompletionPlan({ caller, existingLinkUserId: 'someone-else' }), 'sign-in-existing')
  assert.equal(giceCompletionPlan({ caller: null, existingLinkUserId: 'someone-else' }), 'sign-in-existing')
})
