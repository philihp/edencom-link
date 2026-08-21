import { Suspense } from 'react'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'
import { referralForAccount, type Referral } from '../lib/referral'

import RegisterForm from './registerForm'

// useSearchParams() in the form requires a Suspense boundary for prerender.
// Only a member is sent away — an account still mid-flow (anonymous, no
// character yet) belongs here, since this page is where it becomes real. That
// account may already carry a referral, in which case the form names the
// inviter rather than asking for a code it has no use for.
const RegisterPage = async () => {
  const user = await establishedUser()
  if (user) {
    redirect('/')
  }

  const supabase = await createClient()
  const {
    data: { user: sessionUser },
  } = await supabase.auth.getUser()
  const referral: Referral = sessionUser
    ? await referralForAccount(sessionUser.id)
    : { referred: false, inviterName: null }

  return (
    <Suspense>
      <RegisterForm referral={referral} />
    </Suspense>
  )
}

export default RegisterPage
