// Discord as a way in (docs/open-registration.md, stage 5): the switch that
// decides whether the entry points appear, and the choice between converting
// the account the caller is holding and signing them in fresh.
//
// The gate is a string from the environment, so the parsing is worth pinning:
// the failure that matters is a deployment that sets DISCORD_AUTH to something
// well-meant and gets a button pointing at a provider nobody enabled.
import assert from 'node:assert/strict'
import test from 'node:test'

import { discordAuthConfigured } from '../src/app/account/lib/discordAuth.ts'
import { discordEntryPlan } from '../src/app/account/lib/signupFlow.ts'

test('the usual ways of writing "on" all enable the entry points', () => {
  assert.equal(discordAuthConfigured('1'), true)
  assert.equal(discordAuthConfigured('true'), true)
  assert.equal(discordAuthConfigured('TRUE'), true)
  assert.equal(discordAuthConfigured('on'), true)
  assert.equal(discordAuthConfigured(' yes '), true)
})

test('unset, empty, or anything else leaves them hidden', () => {
  assert.equal(discordAuthConfigured(undefined), false)
  assert.equal(discordAuthConfigured(''), false)
  assert.equal(discordAuthConfigured('0'), false)
  assert.equal(discordAuthConfigured('false'), false)
  assert.equal(discordAuthConfigured('soon'), false)
})

test('a caller already holding an account has Discord linked onto it', () => {
  assert.equal(discordEntryPlan({ userId: 'caller' }), 'link')
})

test('a caller with no session signs in, which creates the account if needed', () => {
  assert.equal(discordEntryPlan(null), 'sign-in')
})
