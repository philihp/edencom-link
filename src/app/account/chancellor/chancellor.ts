import { createServiceClient } from '@/utils/supabase/service'

// Whether the given account is a Chancellor — an account with elevated powers
// (minting invite codes off-schedule, and granting/revoking Chancellor on other
// accounts). Read with the service role so the answer is trustworthy on the
// server regardless of the caller's RLS view. Accounts with no settings row yet
// are not Chancellors.
export const isChancellor = async (userId: string): Promise<boolean> => {
  const service = createServiceClient()
  const { data } = await service
    .from('user_settings')
    .select('is_chancellor')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.is_chancellor === true
}
