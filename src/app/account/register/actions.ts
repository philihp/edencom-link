'use server'

import { createClient } from '@/utils/supabase/server'

export const register = async (formData: FormData, captchaToken: string) => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.signUp({
    email: `${formData.get('email')}`,
    password: `${formData.get('password')}`,
    ...(process.env.NODE_ENV === 'production' ? { options: { captchaToken } } : {}),
  })

  return { data, error }
}
