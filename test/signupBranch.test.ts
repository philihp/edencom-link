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
// depend on mail being sent.
//
// What it asserts, mirroring src/app/account/register/actions.ts (which can't be
// imported here — it is a 'use server' module reading cookies):
//   1. an unused invite code gates registration,
//   2. signUp creates an account in auth.users,
//   3. the code is burned for exactly that account,
//   4. the new account can act as itself under RLS (writes and reads back its
//      own user_settings row) and cannot see another account's.
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

  // The registration path itself: check the code is unredeemed, sign up, burn
  // the code for the new account. Returns what the caller needs to assert on.
  const register = async (code: string): Promise<Registration> => {
    const { data: invite } = await service
      .from('invite_code')
      .select('id')
      .eq('code', code)
      .is('redeemed_by', null)
      .maybeSingle()
    if (!invite) {
      return {
        user: null,
        session: null,
        email: null,
        password: null,
        reason: 'invalid or already-used invite code',
      }
    }

    const email = `signup-test-${randomUUID()}@edencom.test`
    const password = `${randomUUID()}Aa1!`
    const { data, error } = await anonClient().auth.signUp({ email, password })
    assert.equal(error, null, `signUp failed: ${error?.message}`)
    assert.ok(data.user, 'signUp returned no user')
    createdUserIds.push(data.user.id)

    const { error: burnError } = await service
      .from('invite_code')
      .update({ redeemed_by: data.user.id, redeemed_at: new Date().toISOString() })
      .eq('id', invite.id)
      .is('redeemed_by', null)
    assert.equal(burnError, null, `burning the invite code failed: ${burnError?.message}`)

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

  it('creates an account and burns the invite code', { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it('refuses to re-use a burned invite code', { timeout: TEST_TIMEOUT_MS }, async () => {
    const code = await mintInvite()
    await register(code)

    const second = await register(code)
    assert.equal(second.user, null)
    assert.match(`${second.reason}`, /invite code/)
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
