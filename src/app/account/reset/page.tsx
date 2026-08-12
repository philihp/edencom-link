import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'

import { ResetForm } from './resetForm'

const ResetPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (user) {
    redirect('/account/settings')
  }

  return <ResetForm />
}

export default ResetPage
