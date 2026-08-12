'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { mainCharacterNameForUser } from '../lib/inviter'
import { INVITE_CODE_PATTERN } from './inviteCode'

export type AffixResult = 'affixed' | 'already-referred' | 'unavailable' | 'no-session'

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

// Affix an invite code to the caller's account as referral attribution — the
// code no longer admits anyone, it only records who sent them
// (docs/open-registration.md). Called on arrival at /account/register?invite=…,
// so the account it lands on is usually the anonymous one the root layout just
// minted; whatever identity that account later grows keeps the referral,
// because the user id never changes.
//
// First referral wins: an account that already redeemed a code is left alone.
export const affixInvite = async (rawCode: string): Promise<AffixResult> => {
  const code = `${rawCode ?? ''}`.trim()
  if (!INVITE_CODE_PATTERN.test(code)) return 'unavailable'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return 'no-session'

  // Service role throughout: invite_code is read-only to authenticated users
  // (and only for codes they minted), so the caller can neither see the code
  // they were sent nor claim it.
  const service = createServiceClient()
  const { data: mine } = await service
    .from('invite_code')
    .select('id')
    .eq('redeemed_by', user.id)
    .limit(1)
    .maybeSingle()
  if (mine) return 'already-referred'

  const { data: affixed } = await service
    .from('invite_code')
    .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
    .eq('code', code)
    // Guards the race two ways: the code must still be unclaimed, and the
    // partial unique index on redeemed_by rejects a second code for this
    // account if a concurrent call slipped past the check above.
    .is('redeemed_by', null)
    .select('id')
    .maybeSingle()
  return affixed ? 'affixed' : 'unavailable'
}

// Who referred the caller, for the "Referred by …" line on the register form.
// Null when no code is affixed; null inviter name for a founding/seed code.
export const affixedReferrer = async (): Promise<{ inviterName: string | null } | null> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  const { data: invite } = await service
    .from('invite_code')
    .select('created_by')
    .eq('redeemed_by', user.id)
    .limit(1)
    .maybeSingle()
  if (!invite) return null

  return { inviterName: invite.created_by ? await mainCharacterNameForUser(invite.created_by) : null }
}

// Registration is invite-only: the form must carry an unused invite code. We
// validate and redeem it with the service role, since a registrant can't see
// invite_code rows under RLS — not even the one they were sent. (Stage 2 of
// docs/open-registration.md drops the requirement; Stage 1 only teaches it
// about codes already affixed to the arriving anonymous account.)
export const register = async (formData: FormData) => {
  await delay(5000)

  const inviteCode = `${formData.get('invite') ?? ''}`.trim()
  if (!inviteCode) {
    return { data: null, error: { message: 'An invite code is required to register.' } }
  }

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
  // Unclaimed, or already affixed to the anonymous account the registrant
  // arrived on (they followed a /account/register?invite=… link) — the code is
  // still theirs to spend either way.
  const claimable = invite && (invite.redeemed_by === null || invite.redeemed_by === caller?.id)
  if (!claimable) {
    return { data: null, error: { message: 'That invite code is invalid or has already been used.' } }
  }

  const { data, error } = await supabase.auth.signUp({
    email: `${formData.get('email')}`,
    password: `${formData.get('password')}`,
  })
  if (error || !data?.user) {
    return { data, error }
  }

  // Move the referral onto the account that was just created. Guard on the code
  // still sitting where we found it, so two simultaneous sign-ups can't share
  // one code. (Stage 2 of docs/open-registration.md converts the anonymous user
  // in place instead, at which point the id no longer moves.)
  const claim = service
    .from('invite_code')
    .update({ redeemed_by: data.user.id, redeemed_at: new Date().toISOString() })
    .eq('id', invite.id)
  await (caller ? claim.or(`redeemed_by.is.null,redeemed_by.eq.${caller.id}`) : claim.is('redeemed_by', null))

  return { data, error }
}
