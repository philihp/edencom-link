import { Suspense } from 'react'

import RegisterForm from './registerForm'

// useSearchParams() in the form requires a Suspense boundary for prerender.
const RegisterPage = () => (
  <Suspense>
    <RegisterForm />
  </Suspense>
)

export default RegisterPage
