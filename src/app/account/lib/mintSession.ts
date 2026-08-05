import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// Sign the current browser in as an existing user without a password: mint a
// magic-link token with the service role and immediately consume it on the
// cookie client. generateLink only creates the token — no email is sent — so
// this works for SSO accounts whose address is an undeliverable placeholder.
// Must run where cookies can be set (route handler or server action). Returns
// an error message, or undefined on success.
export const mintSession = async (userId: string): Promise<string | undefined> => {
  const service = createServiceClient()
  const { data: userData, error: userError } = await service.auth.admin.getUserById(userId)
  if (userError || !userData?.user?.email) return 'Could not resolve that account.'

  const { data, error } = await service.auth.admin.generateLink({ type: 'magiclink', email: userData.user.email })
  if (error || !data?.properties?.hashed_token) return error?.message ?? 'Could not create a sign-in token.'

  const supabase = await createClient()
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: data.properties.hashed_token,
  })
  return otpError?.message
}
