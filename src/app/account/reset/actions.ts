'use server'

import { headers } from 'next/headers'
import { createClient } from '@/utils/supabase/server'

export const reset = async (formData: FormData, captchaToken: string) => {
  const headersList = await headers()
  const supabase = await createClient()

  const host = headersList.get('host')
  const { data, error } = await supabase.auth.resetPasswordForEmail(`${formData.get('email')}`, {
    redirectTo: `://${host}/account/settings`,
    captchaToken,
  })

  return { data, error }
}
