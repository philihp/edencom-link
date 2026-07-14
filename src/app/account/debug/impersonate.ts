'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// One hardcoded operator account may impersonate any other account from
// /account/debug, for support/debugging. Gated here — not just by hiding the
// form on the page — since a server action is reachable independent of what
// rendered it. No wider admin-role system exists in this app yet; this exists
// to unblock debugging a specific report without inventing one.
export const ADMIN_USER_ID = '167fa36d-5fb1-4bf0-bdc3-847818971649'

// Swap the caller's own session for a real session as another account, via a
// server-minted magic link: generateLink() (service role) issues a token
// without emailing anything, and verifyOtp() redeems it on the cookie-bound
// client, which writes the resulting session straight into httpOnly cookies —
// nothing session-related ever reaches client-side JS. The admin's own session
// is gone once this succeeds; sign back in as the admin to return.
export const impersonate = async (formData: FormData): Promise<{ error: string } | undefined> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user?.id !== ADMIN_USER_ID) return { error: 'Not authorized.' }

  const targetUserId = `${formData.get('userId') ?? ''}`.trim()
  if (!targetUserId) return { error: 'Enter a user ID.' }

  const service = createServiceClient()

  const { data: target, error: lookupError } = await service.auth.admin.getUserById(targetUserId)
  if (lookupError || !target?.user?.email) return { error: 'No user with that ID.' }

  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: target.user.email,
  })
  if (linkError || !link?.properties?.hashed_token) return { error: linkError?.message ?? 'Could not mint a link.' }

  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'email',
  })
  if (verifyError) return { error: verifyError.message }

  // Best-effort audit trail — the impersonation has already happened by this
  // point, so a logging failure shouldn't block the redirect.
  await service.from('impersonation_log').insert({ admin_user_id: user.id, target_user_id: targetUserId })

  redirect('/')
}
