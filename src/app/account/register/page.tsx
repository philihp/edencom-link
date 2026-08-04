import { Suspense } from 'react'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import RegisterForm from './registerForm'

// useSearchParams() in the form requires a Suspense boundary for prerender.
const RegisterPage = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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
