import { createServiceClient } from '@/utils/supabase/service'

// A user's public-facing name: their main character, falling back to their
// earliest one. Service role, since the inviter's registrations sit behind
// their own RLS and the caller may not even have a session yet.
export const mainCharacterNameForUser = async (userId: string): Promise<string | null> => {
  const service = createServiceClient()
  const { data } = await service
    .from('registration')
    .select('name')
    .eq('user_id', userId)
    .order('is_main', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.name ?? null
}
