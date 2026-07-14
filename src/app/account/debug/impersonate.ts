'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { ADMIN_USER_ID } from './adminUserId'

// Swap the caller's own session for a real session as another account, via a
// server-minted magic link: generateLink() (service role) issues a token
// without emailing anything, and verifyOtp() redeems it on the cookie-bound
// client, which writes the resulting session straight into httpOnly cookies —
// nothing session-related ever reaches client-side JS. The admin's own session
// is gone once this succeeds; sign back in as the admin to return. Re-checks
// the caller here — not just by hiding the form on the page — since a server
// action is reachable independent of what rendered it.
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
