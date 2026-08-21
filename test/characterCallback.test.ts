// Which account an EVE SSO callback lands on (docs/open-registration.md, stage
// 3), and whether the account it lands on can ever be signed into again.
//
// The plan's whole job is to tell a returning player from a second account: EVE
// SSO isn't a Supabase identity, so a character is attached to whatever session
// happens to be present, and a browser that lost its cookies presents a brand
// new anonymous one. Getting it wrong splits a player's data across two
// accounts holding the same character. Getting it too eager would sign a
// signed-in member out of the account they were using.
import assert from 'node:assert/strict'
import test from 'node:test'

import { characterCallbackPlan } from '../src/app/account/lib/signupFlow.ts'
import { eveEmail, isSsoPlaceholderEmail, needsDurableIdentity } from '../src/app/account/lib/ssoEmail.ts'

const driveBy = { userId: 'caller', isAnonymous: true, hasRegistration: false }
const member = { userId: 'caller', isAnonymous: false, hasRegistration: true }

test('a character nobody has registered is attached to the caller', () => {
  assert.equal(characterCallbackPlan({ caller: driveBy, existingOwnerUserId: null }), 'attach')
})

test('a returning player with no cookies is signed into the account holding the character', () => {
  assert.equal(characterCallbackPlan({ caller: driveBy, existingOwnerUserId: 'owner' }), 'sign-in-existing')
})

test('re-authorizing a character already on this account just attaches', () => {
  assert.equal(
    characterCallbackPlan({ caller: driveBy, existingOwnerUserId: 'caller' }),
    'attach',
    'the caller and the owner are the same account'
  )
})

test('an established caller is never signed out of the account they are using', () => {
  assert.equal(characterCallbackPlan({ caller: member, existingOwnerUserId: 'owner' }), 'attach')
})

test('an EVE-only account counts as established the moment it owns a character', () => {
  const eveOnly = { userId: 'caller', isAnonymous: true, hasRegistration: true }
  assert.equal(characterCallbackPlan({ caller: eveOnly, existingOwnerUserId: 'owner' }), 'attach')
})

test('the EVE placeholder address is one Supabase can address and nobody can read', () => {
  assert.equal(eveEmail(90000001), 'eve-90000001@sso.edencom.link')
  assert.equal(isSsoPlaceholderEmail(eveEmail(90000001)), true)
})

test('an account with no address, or only an EVE placeholder, still needs a durable identity', () => {
  assert.equal(needsDurableIdentity(null), true)
  assert.equal(needsDurableIdentity(eveEmail(90000001)), true)
})

test('a GICE placeholder does not — that account can come back through GICE', () => {
  assert.equal(needsDurableIdentity('gice-42@sso.edencom.link'), false)
})

test('a real address is never mistaken for a placeholder, however it starts', () => {
  assert.equal(needsDurableIdentity('pilot@example.com'), false)
  assert.equal(needsDurableIdentity('eve-fan@example.com'), false)
})
