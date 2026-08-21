import { createServiceClient } from '@/utils/supabase/service'

import { INVITE_CODE_PATTERN } from '../register/inviteCode'
import { mainCharacterNameForUser } from './inviter'

// Invite codes as referrals (docs/open-registration.md): a code no longer
// admits anyone — registration is open — it records who sent them. The reads
// and writes here are service-role because a registrant cannot see
// `invite_code` rows under RLS, not even the one they were handed.
const INVALID_CODE = 'That invite code is invalid or has already been used.'

export type CodeCheck = { ok: true; inviteId: string } | { ok: false; message: string }

// Check a code before anything irreversible happens. A code the visitor typed
// on purpose and got wrong is worth stopping for, even though nothing depends
// on having one — silently dropping it would lose the referral without saying
// so.
export const checkInviteCode = async (rawCode: string): Promise<CodeCheck | null> => {
  const code = `${rawCode ?? ''}`.trim()
  if (code === '') return null
  if (!INVITE_CODE_PATTERN.test(code)) return { ok: false, message: INVALID_CODE }

  const service = createServiceClient()
  const { data: invite } = await service
    .from('invite_code')
    .select('id')
    .eq('code', code)
    .is('redeemed_by', null)
    .maybeSingle()
  return invite ? { ok: true, inviteId: invite.id } : { ok: false, message: INVALID_CODE }
}

// Record the referral against an account. Guarded twice: on the code still
// being unredeemed, so two simultaneous sign-ups can't share one, and on the
// account not already carrying a referral, which the partial unique index on
// `invite_code (redeemed_by)` would refuse anyway. Best-effort by design — by
// the time this runs the account exists, and losing the attribution is not
// worth failing a registration over.
export const affixReferral = async (inviteId: string, userId: string): Promise<void> => {
  const service = createServiceClient()
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
  if (error) console.warn(`[referral] affixing ${inviteId} to ${userId} failed: ${error.message}`)
}

// Whether this account already carries a referral, and who to credit for it —
// the "Referred by …" line the register form shows instead of an invite field.
// The two are separate answers: a founding/seed code has no creator to name,
// but it still occupies the account's one referral slot, so the form must not
// go on offering to take another code.
export type Referral = { referred: boolean; inviterName: string | null }

export const referralForAccount = async (userId: string): Promise<Referral> => {
  const service = createServiceClient()
  const { data } = await service.from('invite_code').select('created_by').eq('redeemed_by', userId).maybeSingle()
  if (!data) return { referred: false, inviterName: null }
  return {
    referred: true,
    inviterName: data.created_by ? await mainCharacterNameForUser(data.created_by) : null,
  }
}
