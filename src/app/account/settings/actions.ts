'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

export const logoff = async () => {
  const supabase = await createClient()

  const { error } = await supabase.auth.signOut({ scope: 'local' })

  if (error) {
    return error?.message
  }

  redirect('/')
}

export const changePassword = async (formData: FormData) => {
  const supabase = await createClient()

  const password = formData.get('password') as string
  const confirm = formData.get('confirm') as string

  if (password !== confirm) {
    return 'Passwords do not match'
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    return error?.message
  }
}
