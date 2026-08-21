// Integration coverage for registration, run against a real Supabase preview
// branch (Pro-plan database branching) rather than a stand-in: a signed-up
// account only exists if GoTrue, auth.users, the invite_code table and the RLS
// policies all agree, and none of that is exercisable from a pure unit test.
//
// The whole file skips with a printed reason unless the branch env is set — see
// test/lib/supabaseBranch.ts for the two supported shapes (create-per-run, or
// reuse a branch someone else provisioned). So `pnpm test` stays offline by
// default; `pnpm run test:branch` is the same file with credentials in hand.
//
// The signUp below is a real GoTrue signup and would mail the address it is
// given: a branch inherits production's SMTP, so those bounced off the real
// sender. createTestBranch now disables outbound mail on the branch and
// verifies it before returning, and refuses the branch otherwise — so nothing
// here can reach an inbox. Keep it that way: no auth call in this file may
// depend on mail being sent, and none may assume the address domain is doing
// the protecting (see `credentials` below — the domain only has to satisfy
// GoTrue's validator).
//
// What it asserts, mirroring src/app/account/register/actions.ts (which can't be
// imported here — it is a 'use server' module reading cookies):
//   1. signUp creates an account in auth.users, with or without a code,
//   2. a code that is offered is recorded as a referral on exactly that account,
//      and cannot be recorded twice,
//   3. registering from an anonymous session converts that account in place
//      rather than minting a second one,
//   4. an account that started out anonymous can be signed back in with nothing
//      but a placeholder address and a magic-link token — the mechanism behind
//      "Log in with EVE Online" (stage 3),
//   5. the new account can act as itself under RLS (writes and reads back its
//      own user_settings row) and cannot see another account's.
//
// Registration is open as of stage 2, so a code no longer gates anything; what
// is worth pinning here is that the referral still lands on the right account,
// and that the conversion keeps auth.uid() stable — the whole reason a
// character added before signing up survives the sign-up.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { branchSkipReason, createTestBranch, deleteTestBranch, type BranchTarget } from './lib/supabaseBranch.ts'

// Convenience for local runs; CI passes the credentials in the environment.
try {
  process.loadEnvFile('.env')
} catch {
  // no .env — the env is expected to carry the credentials already
}

// Provisioning a branch is minutes, not seconds.
const SETUP_TIMEOUT_MS = 12 * 60 * 1000
const TEST_TIMEOUT_MS = 60 * 1000

const skip = branchSkipReason()

describe('signing up on a Supabase branch', { skip: skip ?? false, timeout: SETUP_TIMEOUT_MS }, () => {
  let branch: BranchTarget
  let service: SupabaseClient
  // Every auth user minted here, torn down after the suite so a reused branch
  // does not accumulate accounts.
  const createdUserIds: string[] = []

  const anonClient = () =>
    createClient(branch.url, branch.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

  // A fresh unredeemed code, as the invite flow's service-role half would mint.
  const mintInvite = async () => {
    const code = randomBytes(8).toString('hex')
    const { error } = await service.from('invite_code').insert({ code })
    assert.equal(error, null, `seeding an invite code failed: ${error?.message}`)
    return code
  }

  type Registration = {
    user: { id: string } | null
    session: unknown
    email: string | null
    password: string | null
    reason: string | null
  }

  // A subdomain of the real domain, not the reserved `.test` TLD these used to
  // use: GoTrue now refuses `.test` outright (`email_address_invalid`), and the
  // placeholder addresses this suite already mints on `sso.edencom.link` pass
  // the same validator. Nothing about the domain is what keeps mail off the
  // wire — createTestBranch does that before a test can authenticate, with
  // three independent locks it verifies by reading the config back
  // (autoconfirm, so no mail is generated; SMTP pointed at the branch's own
  // loopback; the built-in mail service floored to one per hour) — and no call
  // in this file asks GoTrue to send anything anyway. `branch-test` has no MX,
  // so even a bounce has nowhere to originate.
  const credentials = () => ({
    email: `signup-test-${randomUUID()}@branch-test.edencom.link`,
    password: `${randomUUID()}Aa1!`,
  })

  // Check a code the way the action does before it touches the account: only a
  // code that exists and is unclaimed is worth carrying forward.
  const checkInvite = async (code: string) => {
    const { data } = await service
      .from('invite_code')
      .select('id')
      .eq('code', code)
      .is('redeemed_by', null)
      .maybeSingle()
    return data?.id ?? null
  }

  // Record the referral, guarded on the code still being unclaimed and on the
  // account not already carrying one — both guards the action applies.
  const affixReferral = async (inviteId: string, userId: string) => {
    const { count } = await service
      .from('invite_code')
      .select('id', { count: 'exact', head: true })
      .eq('redeemed_by', userId)
    if ((count ?? 0) > 0) return
    const { error } = await service
      .from('invite_code')
      .update({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
      .eq('id', inviteId)
      .is('redeemed_by', null)
    assert.equal(error, null, `affixing the referral failed: ${error?.message}`)
  }

  // The registration path itself: an optional code is checked first (a bad one
  // stops the sign-up while the form can still be corrected), the account is
  // created, then the referral is recorded against it.
  const register = async (code?: string): Promise<Registration> => {
    const inviteId = code === undefined ? null : await checkInvite(code)
    if (code !== undefined && !inviteId) {
      return {
        user: null,
        session: null,
        email: null,
        password: null,
        reason: 'invalid or already-used invite code',
      }
    }

    const { email, password } = credentials()
    const { data, error } = await anonClient().auth.signUp({ email, password })
    assert.equal(error, null, `signUp failed: ${error?.message}`)
    assert.ok(data.user, 'signUp returned no user')
    createdUserIds.push(data.user.id)

    if (inviteId) await affixReferral(inviteId, data.user.id)

    return { user: data.user, session: data.session, email, password, reason: null }
  }

  // A client acting AS the new account. signUp returns a session outright now
  // that the branch autoconfirms (that is what keeps mail off the wire), but
  // the service-role confirm stays as a fallback for a branch configured some
  // other way — the point here is RLS, not the mail settings.
  const signedInClient = async (registered: Registration) => {
    const client = anonClient()
    if (registered.user && !registered.session) {
      const { error } = await service.auth.admin.updateUserById(registered.user.id, { email_confirm: true })
      assert.equal(error, null, `confirming the new account failed: ${error?.message}`)
    }
    const { data, error } = await client.auth.signInWithPassword({
      email: `${registered.email}`,
      password: `${registered.password}`,
    })
    assert.equal(error, null, `signing in as the new account failed: ${error?.message}`)
    assert.ok(data.session, 'no session for the new account')
    return client
  }

  before(async () => {
    branch = await createTestBranch('signup-test')
    service = createClient(branch.url, branch.serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  })

  after(async () => {
    // Deleting the branch drops everything; the per-user cleanup matters only
    // when the run reused a branch it does not own.
    if (branch?.branchId === null && service) {
      await Promise.all(createdUserIds.map((id) => service.auth.admin.deleteUser(id)))
    }
    if (branch) await deleteTestBranch(branch)
  })

  it('creates an account and records the invite code as a referral', { timeout: TEST_TIMEOUT_MS }, async () => {
    const code = await mintInvite()
    const registered = await register(code)
    assert.equal(registered.reason, null)
    assert.ok(registered.user)

    // The account exists in auth.users, not merely in the signUp response.
    const { data: fetched, error } = await service.auth.admin.getUserById(registered.user.id)
    assert.equal(error, null, `looking the new account up failed: ${error?.message}`)
    assert.equal(fetched.user?.id, registered.user.id)
    assert.equal(fetched.user?.email, registered.email)

    const { data: invite } = await service
      .from('invite_code')
      .select('redeemed_by, redeemed_at')
      .eq('code', code)
      .single()
    assert.equal(invite?.redeemed_by, registered.user.id)
    assert.ok(invite?.redeemed_at, 'the redeemed code carries no redemption time')
  })

  it('refuses to re-use a claimed invite code', { timeout: TEST_TIMEOUT_MS }, async () => {
    const code = await mintInvite()
    await register(code)

    const second = await register(code)
    assert.equal(second.user, null)
    assert.match(`${second.reason}`, /invite code/)
  })

  it('creates an account with no invite code at all', { timeout: TEST_TIMEOUT_MS }, async () => {
    const registered = await register()
    assert.equal(registered.reason, null)
    assert.ok(registered.user)

    const { data: fetched } = await service.auth.admin.getUserById(registered.user.id)
    assert.equal(fetched.user?.email, registered.email)

    // Nothing was claimed on its behalf: an open registration is simply
    // unreferred, not credited to some arbitrary code.
    const { count } = await service
      .from('invite_code')
      .select('id', { count: 'exact', head: true })
      .eq('redeemed_by', registered.user.id)
    assert.equal(count, 0)
  })

  it(
    'converts an anonymous account in place instead of minting a second one',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const client = anonClient()
      const { data: anon, error: anonError } = await client.auth.signInAnonymously()
      if (anonError || !anon.user) {
        // Anonymous sign-ins are a project setting (stage 0 of
        // docs/open-registration.md), and a branch inherits whatever the parent
        // has. Say so rather than failing something this file doesn't configure.
        console.log(`# anonymous sign-ins unavailable on this branch: ${anonError?.message}`)
        return
      }
      createdUserIds.push(anon.user.id)
      assert.equal(anon.user.is_anonymous, true)

      // The referral is affixed to the account that already exists — the case
      // that makes conversion worth doing, since a code claimed before sign-up
      // would be stranded on an abandoned account otherwise.
      const code = await mintInvite()
      const inviteId = await checkInvite(code)
      assert.ok(inviteId)
      await affixReferral(inviteId, anon.user.id)

      const { email, password } = credentials()
      const { data: converted, error } = await client.auth.updateUser({ email, password })
      assert.equal(error, null, `converting the anonymous account failed: ${error?.message}`)
      assert.equal(converted.user?.id, anon.user.id, 'conversion minted a different account')

      // Permanent to Supabase now, holding the same id — so the referral (and
      // anything else affixed before sign-up) is still on the account.
      const { data: fetched } = await service.auth.admin.getUserById(anon.user.id)
      assert.equal(fetched.user?.is_anonymous, false)
      assert.equal(fetched.user?.email, email, 'the branch did not apply the new address')

      const { data: invite } = await service.from('invite_code').select('redeemed_by').eq('code', code).single()
      assert.equal(invite?.redeemed_by, anon.user.id)

      // And it is a working password login, not merely a row: the point of
      // converting is that they can come back.
      const { data: signedIn, error: signInError } = await anonClient().auth.signInWithPassword({ email, password })
      assert.equal(signInError, null, `signing in as the converted account failed: ${signInError?.message}`)
      assert.equal(signedIn.user?.id, anon.user.id)
    }
  )

  it('can sign an EVE-only account back in with no password', { timeout: TEST_TIMEOUT_MS }, async () => {
    // The mechanism behind stage 3's "Log in with EVE Online": an account whose
    // only identity is a character has no password and never had a deliverable
    // address, so getting back into it means minting a magic-link token — which
    // GoTrue keys on an email. /character/callback therefore stamps a
    // placeholder (eve-<id>@sso.edencom.link) on such an account at its first
    // character. Whether an account that started out anonymous will accept one,
    // and then hand back a session for it, is a GoTrue behaviour rather than
    // something our code decides, which is exactly why it is pinned here.
    const client = anonClient()
    const { data: anon, error: anonError } = await client.auth.signInAnonymously()
    if (anonError || !anon.user) {
      console.log(`# anonymous sign-ins unavailable on this branch: ${anonError?.message}`)
      return
    }
    createdUserIds.push(anon.user.id)

    const placeholder = `eve-${randomUUID()}@sso.edencom.link`
    const { error: stampError } = await service.auth.admin.updateUserById(anon.user.id, {
      email: placeholder,
      email_confirm: true,
    })
    assert.equal(stampError, null, `stamping the placeholder address failed: ${stampError?.message}`)

    // mintSession's two halves: generateLink creates the token without sending
    // mail (the placeholder domain could not receive it anyway), and verifyOtp
    // consumes it on the caller's client.
    const { data: link, error: linkError } = await service.auth.admin.generateLink({
      type: 'magiclink',
      email: placeholder,
    })
    assert.equal(linkError, null, `minting a magic link failed: ${linkError?.message}`)
    assert.ok(link?.properties?.hashed_token, 'no token to consume')

    const recovered = anonClient()
    const { data: session, error: otpError } = await recovered.auth.verifyOtp({
      type: 'magiclink',
      token_hash: link.properties.hashed_token,
    })
    assert.equal(otpError, null, `consuming the magic link failed: ${otpError?.message}`)
    assert.equal(session.user?.id, anon.user.id, 'the recovered session is a different account')
  })

  it('lets the new account own rows under RLS, and only its own', { timeout: TEST_TIMEOUT_MS }, async () => {
    const registered = await register(await mintInvite())
    assert.ok(registered.user)
    const client = await signedInClient(registered)

    // auth.uid() resolves to the new account, so its own settings row inserts
    // and reads back — the practical meaning of "an account was created".
    const { error: insertError } = await client
      .from('user_settings')
      .insert({ user_id: registered.user.id, enabled_scopes: ['publicData'] })
    assert.equal(insertError, null, `the new account could not write its own settings: ${insertError?.message}`)

    const { data: own } = await client.from('user_settings').select('user_id, enabled_scopes')
    assert.deepEqual(
      own?.map(({ user_id }) => user_id),
      [registered.user.id]
    )
    assert.deepEqual(own?.[0]?.enabled_scopes, ['publicData'])

    // A second account sees none of it — the row is scoped, not just present.
    const other = await register(await mintInvite())
    assert.ok(other.user)
    const otherClient = await signedInClient(other)
    const { data: theirs } = await otherClient.from('user_settings').select('user_id')
    assert.deepEqual(theirs, [])
  })
})

if (skip) console.log(`# skipping the Supabase branch signup test: ${skip}`)
