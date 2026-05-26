'use server'

import { setTimeout as delay } from 'node:timers/promises'

import { createClient } from '@/utils/supabase/server'

export const login = async (formData: FormData) => {
  await delay(1000)
  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({
    email: `${formData.get('email')}`,
    password: `${formData.get('password')}`,
  })

  return error?.message
}
