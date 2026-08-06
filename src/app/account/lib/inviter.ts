import { reduce } from 'ramda'

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

// The same lookup for a set of accounts in one query — for listing who redeemed
// each of a user's invite codes without a round trip per code. Rows come back in
// main-first, then oldest-first order, so the first row seen for an account is
// the one to show; accounts with no linked character are simply absent.
export const mainCharacterNamesForUsers = async (userIds: string[]): Promise<Map<string, string>> => {
  if (userIds.length === 0) return new Map()
  const service = createServiceClient()
  const { data } = await service
    .from('registration')
    .select('user_id, name')
    .in('user_id', userIds)
    .order('is_main', { ascending: false })
    .order('created_at', { ascending: true })
  return reduce(
    (acc, r) => (acc.has(r.user_id) ? acc : acc.set(r.user_id, r.name)),
    new Map<string, string>(),
    data ?? []
  )
}
