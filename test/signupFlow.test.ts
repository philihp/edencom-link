// Which account an email/password sign-up lands on, now that registration is
// open (docs/open-registration.md, stage 2). The decision is one line, and both
// ways of getting it wrong cost something real: converting nothing when a
// session is already in hand leaves the visitor with two accounts — the
// anonymous one holding the character they just added, and the new one holding
// their password — while converting a permanent session would rewrite a signed-in
// member's credentials from the register form.
import assert from 'node:assert/strict'
import test from 'node:test'

import { emailSignupPlan } from '../src/app/account/lib/signupFlow.ts'

test('an anonymous session is converted in place, keeping its id', () => {
  assert.equal(emailSignupPlan({ isAnonymous: true }), 'convert')
})

test('no session at all still signs up outright', () => {
  assert.equal(emailSignupPlan(null), 'sign-up')
})

test('a permanent session is not silently rewritten', () => {
  assert.equal(emailSignupPlan({ isAnonymous: false }), 'sign-up')
})
