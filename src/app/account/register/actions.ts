'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

// Registration is invite-only: the form must carry an unused invite code. We
// validate and redeem it with the service role, since the registrant has no
// Supabase session yet and so can't see invite_code rows under RLS.
export const register = async (formData: FormData) => {
  await delay(5000)

  const inviteCode = `${formData.get('invite') ?? ''}`.trim()
  if (!inviteCode) {
    return { data: null, error: { message: 'An invite code is required to register.' } }
  }

  const service = createServiceClient()
  const { data: invite } = await service
    .from('invite_code')
    .select('id')
    .eq('code', inviteCode)
    .is('redeemed_by', null)
    .maybeSingle()
  if (!invite) {
    return { data: null, error: { message: 'That invite code is invalid or has already been used.' } }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email: `${formData.get('email')}`,
    password: `${formData.get('password')}`,
  })
  if (error || !data?.user) {
    return { data, error }
  }

  // Burn the code for the new account. Guard on it still being unredeemed so two
  // simultaneous sign-ups can't share one code.
  await service
    .from('invite_code')
    .update({ redeemed_by: data.user.id, redeemed_at: new Date().toISOString() })
    .eq('id', invite.id)
    .is('redeemed_by', null)

  return { data, error }
}
