import { Suspense } from 'react'
import { redirect } from 'next/navigation'

import { establishedUser } from '../lib/establishedUser'

import RegisterForm from './registerForm'

// useSearchParams() in the form requires a Suspense boundary for prerender.
// Only a member is sent away — an account still mid-flow (anonymous, no
// character yet) belongs here, since this page is where it becomes real.
const RegisterPage = async () => {
  const user = await establishedUser()
  if (user) {
    redirect('/')
  }

  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  )
}

export default RegisterPage
