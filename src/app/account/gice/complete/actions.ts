'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { cookies } from 'next/headers'

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

  const service = createServiceClient()
  const { data: invite } = await service
    .from('invite_code')
    .select('id')
    .eq('code', inviteCode)
    .is('redeemed_by', null)
    .maybeSingle()
  if (!invite) return 'That invite code is invalid or has already been used.'

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

    // Burn the code for the new account. Guard on it still being unredeemed so
    // two simultaneous sign-ups can't share one code.
    await service
      .from('invite_code')
      .update({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
      .eq('id', invite.id)
      .is('redeemed_by', null)
  }

  const error = await mintSession(userId)
  if (error) return error

  cookieStore.delete({ name: PENDING_COOKIE, path: OAUTH_COOKIE_PATH })
  return undefined
}
