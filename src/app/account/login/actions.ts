'use server'

import { createClient } from '@/utils/supabase/server'

export const login = async (formData: FormData, captchaToken: string) => {
  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({
    email: `${formData.get('email')}`,
    password: `${formData.get('password')}`,
    ...(process.env.NODE_ENV === 'production' ? { options: { captchaToken } } : {}),
  })

  return error?.message
}
