'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { createClient } from '@/utils/supabase/server'

// Set the signed-in account's email (and optionally a password alongside it).
// The email change is not immediate: Supabase emails the new address a
// confirmation link that lands on /account/confirm. Returns an error message,
// or undefined on success.
export const updateEmail = async (formData: FormData): Promise<string | undefined> => {
  await delay(1000)

  const email = `${formData.get('email') ?? ''}`.trim()
  if (!email) return 'An email address is required.'

  const password = `${formData.get('password') ?? ''}`
  const confirm = `${formData.get('confirm') ?? ''}`
  if (password && password !== confirm) return 'Passwords do not match.'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return 'You need to be logged in.'

  const { error } = await supabase.auth.updateUser({ email, ...(password ? { password } : {}) })
  return error?.message
}
