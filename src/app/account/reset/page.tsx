import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { ResetForm } from './resetForm'

const ResetPage = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) {
    redirect('/account/settings')
  }

  return <ResetForm />
}

export default ResetPage
