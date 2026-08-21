import type { SupabaseClient } from '@supabase/supabase-js'

// Give an account with no address of its own a placeholder it can be signed
// into later (docs/open-registration.md, stage 3).
//
// Supabase Auth wants an email, and so does mintSession: signing somebody back
// into a passwordless account means minting a magic-link token, and GoTrue keys
// that on an address. An account grown out of an anonymous session — someone who
// added a character, or came in through GICE — has none, so without this it
// could never be reached again from a browser that lost its cookies. The
// placeholder domain receives no mail, which is why it is confirmed on the spot:
// there is nobody to confirm it.
//
// Only ever fills a blank. An account that already has an address keeps it,
// whether that address is real or an older placeholder — this must never
// overwrite the email somebody actually signs in with. Best-effort: a failure
// here must not cost the caller the identity they just proved.
export const ensurePlaceholderEmail = async (service: SupabaseClient, userId: string, address: string) => {
  const { data, error } = await service.auth.admin.getUserById(userId)
  if (error || !data?.user || data.user.email) return
  const { error: updateError } = await service.auth.admin.updateUserById(userId, {
    email: address,
    email_confirm: true,
  })
  if (updateError) console.warn(`[recovery-email] ${userId} could not be given ${address}: ${updateError.message}`)
}
