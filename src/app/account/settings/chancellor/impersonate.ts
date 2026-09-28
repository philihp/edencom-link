'use server'

import { redirect } from 'next/navigation'

import { escapeLike } from '@/utils/escapeLike'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { isChancellor } from './chancellor'
import { ownerOfMatches, parseImpersonationTarget } from './impersonationTarget'

// Swap the caller's own session for a real session as another account, via a
// server-minted magic link: generateLink() (service role) issues a token
// without emailing anything, and verifyOtp() redeems it on the cookie-bound
// client, which writes the resulting session straight into httpOnly cookies —
// nothing session-related ever reaches client-side JS. The caller's own
// session is gone once this succeeds; sign back in normally to return.
// Re-checks Chancellor status here — not just by hiding the form on the page
// — since a server action is reachable independent of what rendered it.
//
// The box takes a user id or a character name (impersonationTarget.ts). A
// name resolves through `registration` on the service client — the
// Chancellor is not in that account, so RLS would show nothing — to the one
// account owning a character of that name; two owners is refused.
export const impersonate = async (formData: FormData): Promise<{ error: string } | undefined> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id || !(await isChancellor(user.id))) return { error: 'Not authorized.' }

  const target = parseImpersonationTarget(`${formData.get('target') ?? ''}`)
  if (target.kind === 'empty') return { error: 'Enter a user ID or a character name.' }

  const service = createServiceClient()

  const resolved =
    target.kind === 'user'
      ? { ok: true as const, userId: target.userId }
      : await userIdOfCharacter(service, target.name)
  if (!resolved.ok) return { error: resolved.error }
  const targetUserId = resolved.userId

  const { data: targetUser, error: lookupError } = await service.auth.admin.getUserById(targetUserId)
  if (lookupError || !targetUser?.user?.email) return { error: 'No user with that ID.' }

  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: targetUser.user.email,
  })
  if (linkError || !link?.properties?.hashed_token) return { error: linkError?.message ?? 'Could not mint a link.' }

  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'email',
  })
  if (verifyError) return { error: verifyError.message }

  // Best-effort audit trail — the impersonation has already happened by this
  // point, so a logging failure shouldn't block the redirect.
  await service.from('impersonation_log').insert({ chancellor_user_id: user.id, target_user_id: targetUserId })

  redirect('/')
}

// The account owning a character of this name, exactly (case-insensitively)
// — `ilike` with the wildcards escaped, since a Chancellor may paste a name
// straight from chat. Nobody, or more than one account, is a refusal.
const userIdOfCharacter = async (
  service: ReturnType<typeof createServiceClient>,
  name: string
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> => {
  const { data } = await service
    .from('registration')
    .select('user_id')
    .ilike('name', escapeLike(name))
    .returns<Array<{ user_id: string | null }>>()
  const owner = ownerOfMatches(data ?? [])
  if (owner.ok) return owner
  return {
    ok: false,
    error:
      owner.reason === 'none'
        ? `No account has a character named “${name}”.`
        : `More than one account has a character named “${name}”.`,
  }
}
