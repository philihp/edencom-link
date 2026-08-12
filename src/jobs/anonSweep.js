import { sudoSupabase, sudoSupabaseAdmin } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'anon-sweep'

// How long a drive-by account is kept before it is deleted, and how many go per
// run. The cap only bounds one night's work: the sweep runs daily and the
// backlog is drained across runs.
const MAX_AGE = '30 days'
const MAX_PER_RUN = 500

// Anonymous accounts that never became anything → deleted. Every visitor gets a
// Supabase anonymous user on arrival (docs/open-registration.md), so most of
// auth.users is people who looked at the front page once; this is what keeps
// that bounded.
//
// The "never became anything" test lives in sweepable_anonymous_users(): no
// character, no GICE link, no Supabase identity beyond the anonymous one. It is
// deliberately not `is_anonymous and old`, because an account whose only
// identity is an EVE SSO character stays anonymous in Supabase's eyes forever
// and is very much a real account.
//
// Deleting the auth user cascades: registration, user_settings, watched_system
// and friends all key on it, and invite_code.redeemed_by is `on delete set
// null`, so an affixed-but-never-converted referral returns to the pool.
export const runAnonSweep = async () => {
  const { data: candidates, error } = await sudoSupabase.rpc('sweepable_anonymous_users', {
    older_than: MAX_AGE,
    max_rows: MAX_PER_RUN,
  })
  if (error) throw new Error(`[${TAG}] listing sweepable users failed: ${error.message}`)

  const userIds = (candidates ?? []).map((row) => (typeof row === 'string' ? row : row.sweepable_anonymous_users))
  if (userIds.length === 0) {
    console.log(`[${TAG}] nothing to sweep`)
    return
  }

  // One at a time: the admin API is rate limited, and a failure on one account
  // (a row that grew a character between the query and the delete) shouldn't
  // cost the rest of the batch.
  let deleted = 0
  let failed = 0
  await forEachSequential(userIds, async (userId) => {
    const { error: deleteError } = await sudoSupabaseAdmin.deleteUser(userId)
    if (deleteError) {
      failed += 1
      console.error(`[${TAG}] deleting ${userId} FAILED message=${deleteError.message}`)
      return
    }
    deleted += 1
  })

  console.log(`[${TAG}] deleted=${deleted} failed=${failed} candidates=${userIds.length}`)
  if (deleted === 0 && failed > 0) throw new Error(`[${TAG}] every delete failed`)
}

cli(import.meta.url, TAG, runAnonSweep)
