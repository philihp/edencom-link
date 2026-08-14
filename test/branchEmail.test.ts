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

import { EMAIL_DISABLED_ATTEMPTS, isSinkSmtpHost, mailIsDisabled, refFromUrl } from './lib/supabaseBranch.ts'

test('every candidate config skips signup confirmation mail', () => {
  EMAIL_DISABLED_ATTEMPTS.forEach((attempt) => {
    assert.equal(attempt.mailer_autoconfirm, true)
    assert.equal(attempt.mailer_secure_email_change_enabled, false)
  })
})

test('no candidate config can reach a real mail server', () => {
  EMAIL_DISABLED_ATTEMPTS.forEach((attempt) => {
    assert.equal(isSinkSmtpHost('smtp_host' in attempt ? attempt.smtp_host : undefined), true)
  })
})

test('the sender address the API insists on is itself undeliverable', () => {
  // The Management API format-checks smtp_admin_email and rejects an empty
  // string outright, so it gets a syntactically valid address at a reserved
  // TLD that cannot resolve — never a real mailbox.
  EMAIL_DISABLED_ATTEMPTS.filter((attempt) => 'smtp_admin_email' in attempt).forEach((attempt) => {
    assert.match(`${attempt.smtp_admin_email}`, /^[^@\s]+@[^@\s]+\.invalid$/)
  })
})

test('a loopback or absent SMTP host counts as a sink, a real one does not', () => {
  assert.equal(isSinkSmtpHost('127.0.0.1'), true)
  assert.equal(isSinkSmtpHost('  LocalHost '), true)
  assert.equal(isSinkSmtpHost(''), true)
  assert.equal(isSinkSmtpHost(undefined), true)
  assert.equal(isSinkSmtpHost('email-smtp.us-east-1.amazonaws.com'), false)
})

test('a silenced branch passes the check', () => {
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: '127.0.0.1' }), true)
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: '' }), true)
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: null }), true)
})

test('a branch that can still send is refused', () => {
  // Confirmation mail on: signUp mails the address.
  assert.equal(mailIsDisabled({ mailer_autoconfirm: false, smtp_host: '' }), false)
  // Production's sender still configured: recovery mail would go out for real.
  assert.equal(mailIsDisabled({ mailer_autoconfirm: true, smtp_host: 'smtp.example.com' }), false)
  assert.equal(mailIsDisabled({ mailer_autoconfirm: false, smtp_host: 'email-smtp.us-east-1.amazonaws.com' }), false)
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
