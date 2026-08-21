'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { cookies } from 'next/headers'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { mintSession } from '../../lib/mintSession'
import { ensurePlaceholderEmail } from '../../lib/recoveryEmail'
import { affixReferral, checkInviteCode } from '../../lib/referral'
import { giceCompletionPlan } from '../../lib/signupFlow'
import { giceEmail } from '../../lib/ssoEmail'
import { decodePendingIdentity, OAUTH_COOKIE_PATH, PENDING_COOKIE } from '../oidc'

// Finish a GICE registration. The pending cookie proves who they are; nothing
// else is required of them (docs/open-registration.md, stage 4 — GICE was the
// last gated way in). An invite code is optional and, when offered, is recorded
// as a referral, exactly as on the email path.
//
// Where the account comes from depends on what the caller is holding, which
// `giceCompletionPlan` decides: a session is linked and converted in place (no
// second account, no mintSession — they are already signed in), a GICE identity
// already linked elsewhere signs them into that account, and a caller with no
// session at all gets one minted outright.
//
// Returns an error message, or undefined on success.
export const completeGiceRegistration = async (formData: FormData): Promise<string | undefined> => {
  await delay(1000)

  const cookieStore = await cookies()
  const identity = decodePendingIdentity(cookieStore.get(PENDING_COOKIE)?.value)
  if (!identity) return 'Your GICE sign-in expired — start over from the login page.'

  // Checked before the account is touched, so a mistyped code fails while it
  // can still be corrected.
  const invite = await checkInviteCode(`${formData.get('invite') ?? ''}`)
  if (invite && !invite.ok) return invite.message

  const service = createServiceClient()
  const supabase = await createClient()
  const {
    data: { user: sessionUser },
  } = await supabase.auth.getUser()

  // Someone may have linked this GICE account since the callback ran (another
  // tab finishing first), which is what makes the already-linked case real
  // rather than theoretical.
  const { data: existing } = await service
    .from('gice_account')
    .select('user_id')
    .eq('gice_id', identity.giceId)
    .maybeSingle()

  const plan = giceCompletionPlan({
    caller: sessionUser ? { userId: sessionUser.id } : null,
    existingLinkUserId: existing?.user_id ?? null,
  })

  const link = async (userId: string) => {
    if (existing?.user_id === userId) return undefined
    const { error } = await service.from('gice_account').insert({
      gice_id: identity.giceId,
      user_id: userId,
      name: identity.name,
      primary_group: identity.primaryGroup,
    })
    return error ? `Could not link your GICE account: ${error.message}` : undefined
  }

  let userId: string
  if (plan === 'create') {
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email: giceEmail(identity.giceId),
      email_confirm: true,
      user_metadata: { gice_id: identity.giceId, gice_name: identity.name },
    })
    if (createError || !created?.user) return createError?.message ?? 'Could not create your account.'
    userId = created.user.id

    const linkError = await link(userId)
    if (linkError) return linkError
  } else if (plan === 'link-in-place') {
    userId = sessionUser!.id
    const linkError = await link(userId)
    if (linkError) return linkError
    // The account may have grown out of an anonymous session and have no
    // address of its own; the GICE placeholder is what makes it permanent and
    // reachable. An account that already has one — a real address, or the EVE
    // placeholder from a character add — keeps it.
    await ensurePlaceholderEmail(service, userId, giceEmail(identity.giceId))
  } else {
    userId = existing!.user_id
  }

  if (invite?.ok) await affixReferral(invite.inviteId, userId)

  // Already signed in on the converted account; the other two paths need a
  // session minted for the account they landed on.
  if (plan !== 'link-in-place') {
    const error = await mintSession(userId)
    if (error) return error
  }

  cookieStore.delete({ name: PENDING_COOKIE, path: OAUTH_COOKIE_PATH })
  return undefined
}
