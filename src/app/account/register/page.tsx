import { Suspense } from 'react'
import { redirect } from 'next/navigation'

import { establishedUser } from '../lib/establishedUser'

import AffixInviteOnArrival from './affixInviteOnArrival'
import RegisterForm from './registerForm'

// useSearchParams() in the form requires a Suspense boundary for prerender.
// Only a member is sent away: a visitor is signed in anonymously by now, and
// this page is exactly where they turn that into an account.
const RegisterPage = async ({ searchParams }: { searchParams: Promise<{ invite?: string }> }) => {
  const user = await establishedUser()
  if (user) {
    redirect('/')
  }

  const { invite } = await searchParams

  return (
    <Suspense>
      <AffixInviteOnArrival code={invite?.trim() ?? ''} />
      <RegisterForm />
    </Suspense>
  )
}

export default RegisterPage
