// Unit coverage for the one question the whole app now has to ask about a
// session: is this a member, or an account still mid-flow on the anonymous
// session a character add or sign-up minted (docs/open-registration.md)?
//
// It looks trivial, and its two clauses are exactly the two mistakes worth
// pinning: reading Supabase's is_anonymous flag as the answer (which evicts
// every EVE-SSO-only account, permanent to us and anonymous forever to
// Supabase), or forgetting the flag and treating a drive-by visitor as signed
// in. The SQL twin is is_established_account() in schema.sql.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isEstablishedAccount } from '../src/app/account/lib/accountStatus.ts'

test('a permanent Supabase user is established', () => {
  assert.equal(isEstablishedAccount({ isAnonymous: false, hasRegistration: false }), true)
})

test('an EVE-SSO-only account is established despite staying anonymous to Supabase', () => {
  assert.equal(isEstablishedAccount({ isAnonymous: true, hasRegistration: true }), true)
})

test('an account that started a flow and walked away is not', () => {
  assert.equal(isEstablishedAccount({ isAnonymous: true, hasRegistration: false }), false)
})
