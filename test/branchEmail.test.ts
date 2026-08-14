// The one thing the Supabase branch tests must never do: send mail. A preview
// branch clones the parent project's auth configuration, custom SMTP included,
// so a test signup on a branch went out through the production sender to an
// undeliverable @edencom.test address — a bounce charged against the real
// domain every run.
//
// test/lib/supabaseBranch.ts now disables mail on the branch and verifies it
// before handing the branch to any test. The interesting half of that is pure,
// so it is pinned here, offline: the payload that turns mail off, and the
// predicate that decides whether a branch is safe to touch. If a future edit
// weakens either, this fails on every PR rather than in someone's inbox.
import assert from 'node:assert/strict'
import test from 'node:test'

import { EMAIL_DISABLED_CONFIG, mailIsDisabled, refFromUrl } from './lib/supabaseBranch.ts'

test('the branch config skips signup confirmation mail', () => {
  assert.equal(EMAIL_DISABLED_CONFIG.mailer_autoconfirm, true)
  assert.equal(EMAIL_DISABLED_CONFIG.mailer_secure_email_change_enabled, false)
})

test('the branch config clears every inherited SMTP credential', () => {
  // Empty strings, not nulls: the Management API reads null as "unchanged",
  // which would leave production's sender in place on the branch.
  const smtp = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_admin_email', 'smtp_sender_name'] as const
  smtp.forEach((field) => assert.equal(EMAIL_DISABLED_CONFIG[field], '', `${field} must be cleared, not left null`))
})

test('a silenced branch passes the check', () => {
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: '' }), true)
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: null }), true)
})

test('a branch that can still send is refused', () => {
  // Confirmation mail on: signUp mails the address.
  assert.equal(mailIsDisabled({ mailer_autoconfirm: false, smtp_host: '' }), false)
  // Production's sender still configured: recovery mail would go out for real.
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: 'smtp.example.com' }), false)
  // No config read at all is not evidence of anything.
  assert.equal(mailIsDisabled(null), false)
  assert.equal(mailIsDisabled({}), false)
})

test('a branch project ref is recoverable from its URL', () => {
  assert.equal(refFromUrl('https://abcdefghijklmnop.supabase.co'), 'abcdefghijklmnop')
  assert.equal(refFromUrl('https://abcdefghijklmnop.supabase.red'), 'abcdefghijklmnop')
})

test('an unrecognizable branch URL yields no ref, so the run refuses rather than guesses', () => {
  assert.equal(refFromUrl('http://localhost:54321'), null)
  assert.equal(refFromUrl('https://example.com'), null)
})
