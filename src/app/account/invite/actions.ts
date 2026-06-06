'use server'

import { randomBytes } from 'node:crypto'

import { revalidatePath } from 'next/cache'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { earnedCount } from './schedule'

// Mint a new invite code for the signed-in user, provided the earning schedule
// has granted them a slot they haven't already used. Reads/writes go through the
// service role so the schedule is enforced server-side (an authenticated user has
// no insert policy on invite_code and so cannot fabricate codes directly).
export const createInviteCode = async (): Promise<{ code?: string; error?: string }> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { error: 'Not signed in' }

  const service = createServiceClient()

  // When the clock started: the first character this user added via SSO.
  const { data: firstChar } = await service
    .from('registration')
    .select('created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const firstSsoAt = firstChar?.created_at ? new Date(firstChar.created_at) : null

  const { count: createdCount } = await service
    .from('invite_code')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', user.id)

  const available = earnedCount(firstSsoAt) - (createdCount ?? 0)
  if (available <= 0) {
    return { error: 'No invite codes available yet — check back when the next one unlocks.' }
  }

  const code = randomBytes(8).toString('hex')
  const { error } = await service.from('invite_code').insert({ code, created_by: user.id })
  if (error) return { error: error.message }

  revalidatePath('/account/invite')
  return { code }
}
