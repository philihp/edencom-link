import { cache } from 'react'
import type { SupabaseClient, User } from '@supabase/supabase-js'

import { createClient } from '@/utils/supabase/server'

import { isEstablishedAccount } from './accountStatus'

// The signed-in *member*, or null for a visitor riding the anonymous session
// the root layout mints on arrival (docs/open-registration.md). Drop-in for
// `auth.getUser()` at every gate that read "a user exists" as "a member is
// here" — which, since anonymous sign-ins, is no longer the same statement.
//
// Cached per request: the gate, the header, and any nested layout asking the
// same question share one round trip.
export const establishedUser = cache(async (client?: SupabaseClient): Promise<User | null> => {
  const supabase = client ?? (await createClient())
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  if (!user.is_anonymous) return user

  // RLS scopes this to the caller's own registrations, so it is a cheap "do I
  // own a character?" probe rather than a table scan.
  const { count } = await supabase.from('registration').select('id', { count: 'exact', head: true })
  return isEstablishedAccount({ isAnonymous: true, hasRegistration: (count ?? 0) > 0 }) ? user : null
})
