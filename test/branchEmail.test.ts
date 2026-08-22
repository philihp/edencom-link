// The two things the Supabase branch tests must never do: send mail, and leave
// the machine uninvited.
//
// Mail: a preview branch clones the parent project's auth configuration,
// custom SMTP included, so a test signup on a branch went out through the
// production sender to an undeliverable address — a bounce charged against the
// real domain every run. test/lib/supabaseBranch.ts now disables mail on the
// branch and verifies it before handing the branch to any test.
//
// Network: the branch suite reaches the real Supabase Management API and
// provisions a real, billable cloud branch — and `pnpm test` globs it in with
// the offline suites. Credentials alone must never be enough: a filled-in .env
// sits on every dev box, so the suite runs only under the explicit opt-in that
// `pnpm run test:branch` sets.
//
// The interesting halves of both are pure or env-only, so they are pinned
// here, offline: the payload that turns mail off, the predicate that decides
// whether a branch is safe to touch, and the gate that keeps `pnpm test` off
// the network. If a future edit weakens any of them, this fails on every PR
// rather than in someone's inbox or on someone's bill.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  branchSkipReason,
  EMAIL_DISABLED_ATTEMPTS,
  isSinkSmtpHost,
  mailIsDisabled,
  refFromUrl,
  RUN_FLAG,
} from './lib/supabaseBranch.ts'

// Run a block under a temporary environment, restoring whatever was there —
// these tests fake credentials, and must not leak them into a sibling test.
const withEnv = (patch: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]))
  Object.entries(patch).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  try {
    fn()
  } finally {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  }
}

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

test('under plain pnpm test, fetch itself refuses', { skip: process.env.RUN_BRANCH_TESTS === '1' }, () => {
  // The mechanism behind the audit: test/lib/offlineGuard.ts is --import'ed
  // into every test process, so even a network call the skip gate never sees —
  // some future test, or a transitive import — dies here instead of leaving
  // the machine. Skipped under test:branch, where fetch is real by design.
  assert.throws(() => globalThis.fetch('https://example.com'), /test:branch/)
})

test('credentials alone never take the branch suite onto the network', () => {
  withEnv(
    {
      [RUN_FLAG]: undefined,
      SUPABASE_ACCESS_TOKEN: 'sbp_looks_real_enough',
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      SUPABASE_TEST_BRANCH_URL: undefined,
    },
    () => {
      const reason = branchSkipReason()
      assert.ok(reason, 'a fully-credentialed env without the opt-in must still skip')
      assert.match(reason, /test:branch/, 'the skip reason should teach the intended invocation')
    }
  )
})

test('the opt-in plus credentials is what unlocks it', () => {
  withEnv(
    {
      [RUN_FLAG]: '1',
      SUPABASE_ACCESS_TOKEN: 'sbp_looks_real_enough',
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      SUPABASE_TEST_BRANCH_URL: undefined,
    },
    () => assert.equal(branchSkipReason(), null)
  )
})

test('the opt-in without credentials still explains what is missing', () => {
  withEnv(
    {
      [RUN_FLAG]: '1',
      SUPABASE_ACCESS_TOKEN: undefined,
      SUPABASE_PROJECT_REF: undefined,
      SUPABASE_TEST_BRANCH_URL: undefined,
    },
    () => assert.match(`${branchSkipReason()}`, /SUPABASE_ACCESS_TOKEN/)
  )
})
