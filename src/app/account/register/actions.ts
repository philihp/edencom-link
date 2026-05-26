'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { createClient } from '@/utils/supabase/server'

export const register = async (formData: FormData) => {
  await delay(5000)
  const supabase = await createClient()

  const { data, error } = await supabase.auth.signUp({
    email: `${formData.get('email')}`,
    password: `${formData.get('password')}`,
  })

  return { data, error }
}
