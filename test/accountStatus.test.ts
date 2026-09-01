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

import { isEstablishedAccount, sessionUserFromClaims } from '../src/app/account/lib/accountStatus.ts'

test('a permanent Supabase user is established', () => {
  assert.equal(isEstablishedAccount({ isAnonymous: false, hasRegistration: false }), true)
})

test('an EVE-SSO-only account is established despite staying anonymous to Supabase', () => {
  assert.equal(isEstablishedAccount({ isAnonymous: true, hasRegistration: true }), true)
})

test('an account that started a flow and walked away is not', () => {
  assert.equal(isEstablishedAccount({ isAnonymous: true, hasRegistration: false }), false)
})

// ── sessionUserFromClaims ──────────────────────────────────────────────────
// establishedUser() now reads the caller out of the access token's own claims
// rather than asking the Auth server (see the note on the function). That makes
// this mapping the thing standing between a verified JWT and every gate in the
// app, so the shapes a real token can actually arrive in are worth pinning.

test('a permanent account maps to a non-anonymous session user', () => {
  assert.deepEqual(
    sessionUserFromClaims({ sub: 'u-1', email: 'pilot@example.com', is_anonymous: false, role: 'authenticated' }),
    { id: 'u-1', email: 'pilot@example.com', isAnonymous: false }
  )
})

test('an anonymous sign-in is carried through as anonymous', () => {
  assert.deepEqual(sessionUserFromClaims({ sub: 'u-2', is_anonymous: true }), {
    id: 'u-2',
    email: undefined,
    isAnonymous: true,
  })
})

// The flag is optional in auth-js's own claim types. Absent has to mean "not
// anonymous", because Supabase stamps it on every token an anonymous sign-in
// mints — and because that is what the previous `!user.is_anonymous` check did.
// Getting this backwards would evict every established account from the site.
test('an absent is_anonymous claim reads as not anonymous', () => {
  assert.equal(sessionUserFromClaims({ sub: 'u-3', email: 'a@b.c' })?.isAnonymous, false)
})

// Only the literal `true` counts: a string "true" is not the boolean claim, and
// coercing it would send a permanent account down the registration probe.
test('a non-boolean is_anonymous does not make a session anonymous', () => {
  assert.equal(sessionUserFromClaims({ sub: 'u-4', is_anonymous: 'true' })?.isAnonymous, false)
})

// An EVE-SSO-only account had no address of its own before the placeholder
// landed, so `email` really can be missing; needsDurableIdentity() reads the
// absence as "this account has no way back in" and must see undefined, not ''.
test('a missing or non-string email becomes undefined rather than a value', () => {
  assert.equal(sessionUserFromClaims({ sub: 'u-5' })?.email, undefined)
  assert.equal(sessionUserFromClaims({ sub: 'u-6', email: 12345 })?.email, undefined)
})

// No subject means no session. The gates treat null as signed out, so this is
// the branch that keeps an unauthenticated caller out.
test('claims without a usable subject are no session at all', () => {
  assert.equal(sessionUserFromClaims(null), null)
  assert.equal(sessionUserFromClaims(undefined), null)
  assert.equal(sessionUserFromClaims({}), null)
  assert.equal(sessionUserFromClaims({ sub: '' }), null)
  assert.equal(sessionUserFromClaims({ sub: 42 }), null)
})
