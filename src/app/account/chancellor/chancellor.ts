import { createServiceClient } from '@/utils/supabase/service'

// An account is a Chancellor when it has redeemed (burned) an invite_code whose
// is_chancellor flag is set. Read with the service role: a user's own RLS view of
// invite_code only covers the codes they CREATED, not the one they redeemed, so
// the authenticated client can't see what conferred their status.
export const isChancellor = async (userId: string): Promise<boolean> => {
  const service = createServiceClient()
  const { count } = await service
    .from('invite_code')
    .select('id', { count: 'exact', head: true })
    .eq('redeemed_by', userId)
    .eq('is_chancellor', true)
  return (count ?? 0) > 0
}
