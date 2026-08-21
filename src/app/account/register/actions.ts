'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { mainCharacterNameForUser } from '../lib/inviter'
import { affixReferral, checkInviteCode } from '../lib/referral'
import { emailSignupPlan } from '../lib/signupFlow'
import { INVITE_CODE_PATTERN } from './inviteCode'

export type InviteLookup =
  | { status: 'valid'; inviterName: string | null } // null inviter = a founding/seed code
  | { status: 'redeemed' }
  | { status: 'unknown' }

// Resolve who an unredeemed invite code came from, so the register form can
// show "Invited by <main character>" beside the field. Unauthenticated by
// nature (the registrant has no session), so it reveals nothing beyond the
// status for redeemed codes, and only ever names the inviter of a code the
// caller already holds in full.
export const lookupInvite = async (rawCode: string): Promise<InviteLookup> => {
  const code = `${rawCode ?? ''}`.trim()
  if (!INVITE_CODE_PATTERN.test(code)) return { status: 'unknown' }

  const service = createServiceClient()
  const { data: invite } = await service
    .from('invite_code')
    .select('created_by, redeemed_by')
    .eq('code', code)
    .maybeSingle()
  if (!invite) return { status: 'unknown' }
  if (invite.redeemed_by) return { status: 'redeemed' }

  const inviterName = invite.created_by ? await mainCharacterNameForUser(invite.created_by) : null
  return { status: 'valid', inviterName }
}

// Registration is open (docs/open-registration.md): an invite code is optional
// and, when present, is recorded as a referral rather than spent as admission.
//
// The account itself may already exist — a visitor who started adding a
// character is holding an anonymous session — in which case this converts that
// user in place instead of minting a second one, keeping auth.uid() and
// anything already affixed to it. `signUp` remains the no-session fallback.
// Either way the address is confirmed through the existing /account/confirm
// route before it becomes theirs.
export const register = async (formData: FormData) => {
  await delay(5000)

  // Checked before the account is touched, so a mistyped code fails while it
  // can still be corrected in the form.
  const invite = await checkInviteCode(`${formData.get('invite') ?? ''}`)
  if (invite && !invite.ok) {
    return { data: null, error: { message: invite.message } }
  }

  const supabase = await createClient()
  const {
    data: { user: sessionUser },
  } = await supabase.auth.getUser()

  const email = `${formData.get('email')}`
  const password = `${formData.get('password')}`
  const { data, error } =
    emailSignupPlan(sessionUser && { isAnonymous: sessionUser.is_anonymous === true }) === 'convert'
      ? await supabase.auth.updateUser({ email, password })
      : await supabase.auth.signUp({ email, password })
  if (error || !data?.user) {
    return { data, error }
  }

  if (invite?.ok) await affixReferral(invite.inviteId, data.user.id)

  return { data, error }
}
