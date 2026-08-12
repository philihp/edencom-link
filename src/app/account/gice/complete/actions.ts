'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { cookies } from 'next/headers'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

import { mintSession } from '../../lib/mintSession'
import { giceEmail } from '../../lib/ssoEmail'
import { decodePendingIdentity, OAUTH_COOKIE_PATH, PENDING_COOKIE } from '../oidc'

// Finish a GICE registration: the pending cookie proves who they are, the
// invite code proves they were asked in. Mirrors the email register action —
// validate the code, create the account, burn the code — then signs the new
// account in directly (there's no email confirmation to wait on: the account's
// address is an undeliverable placeholder until they add a real one).
// Returns an error message, or undefined on success.
export const completeGiceRegistration = async (formData: FormData): Promise<string | undefined> => {
  await delay(1000)

  const cookieStore = await cookies()
  const identity = decodePendingIdentity(cookieStore.get(PENDING_COOKIE)?.value)
  if (!identity) return 'Your GICE sign-in expired — start over from the login page.'

  const inviteCode = `${formData.get('invite') ?? ''}`.trim()
  if (!inviteCode) return 'An invite code is required to register.'

  // The visitor is riding the anonymous session the root layout minted, so a
  // code they arrived with may already be affixed to it as referral
  // attribution — still theirs to spend (docs/open-registration.md).
  const supabase = await createClient()
  const {
    data: { user: caller },
  } = await supabase.auth.getUser()

  const service = createServiceClient()
  const { data: invite } = await service
    .from('invite_code')
    .select('id, redeemed_by')
    .eq('code', inviteCode)
    .maybeSingle()
  if (!invite || (invite.redeemed_by !== null && invite.redeemed_by !== caller?.id)) {
    return 'That invite code is invalid or has already been used.'
  }

  // Someone may have linked this GICE account since the callback ran (another
  // tab finishing first) — just sign into the account that won.
  const { data: existing } = await service
    .from('gice_account')
    .select('user_id')
    .eq('gice_id', identity.giceId)
    .maybeSingle()

  let userId = existing?.user_id
  if (!userId) {
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email: giceEmail(identity.giceId),
      email_confirm: true,
      user_metadata: { gice_id: identity.giceId, gice_name: identity.name },
    })
    if (createError || !created?.user) {
      return createError?.message ?? 'Could not create your account.'
    }
    userId = created.user.id

    const { error: linkError } = await service.from('gice_account').insert({
      gice_id: identity.giceId,
      user_id: userId,
      name: identity.name,
      primary_group: identity.primaryGroup,
    })
    if (linkError) return `Could not link your GICE account: ${linkError.message}`

    // Move the referral onto the account that was just created. Guard on the
    // code still sitting where we found it — unclaimed, or on the anonymous
    // account this registrant arrived with — so two simultaneous sign-ups
    // can't share one code.
    const claim = service
      .from('invite_code')
      .update({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
      .eq('id', invite.id)
    await (caller ? claim.or(`redeemed_by.is.null,redeemed_by.eq.${caller.id}`) : claim.is('redeemed_by', null))
  }

  const error = await mintSession(userId)
  if (error) return error

  cookieStore.delete({ name: PENDING_COOKIE, path: OAUTH_COOKIE_PATH })
  return undefined
}
