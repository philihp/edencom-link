'use client'

import { useRef, useState } from 'react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'

import { reset } from './actions'

const ResetPage = () => {
  const [disabled, setDisabled] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string>('')
  const turnstileRef = useRef<TurnstileInstance>(undefined)

  const resetAndReturn = async (formData: FormData) => {
    await reset(formData, captchaToken)
    setCaptchaToken('')
    turnstileRef.current?.reset()
    setEmailSent(true)
  }

  const handleEmailChange = () => {
    setDisabled(false)
  }

  return (
    <form
      onSubmit={() => {
        setDisabled(true)
        setEmailSent(false)
      }}
    >
      <h1>Reset Password</h1>
      <p>Forgot your password? Let&apos;s confirm your email to reset it.</p>
      <label htmlFor="email">Email:</label>
      <br />
      <input id="email" name="email" type="email" required onChange={handleEmailChange} />
      <br />
      <button formAction={resetAndReturn} disabled={disabled}>
        Send Email
      </button>
      {emailSent && (
        <>
          <svg height="10" width="20">
            <circle cx="10" cy="5" r="5" fill="#00AF00" />
          </svg>
          Check your email for a link.
        </>
      )}
      {process.env.NODE_ENV === 'production' && (
        <Turnstile
          ref={turnstileRef}
          siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ''}
          onSuccess={setCaptchaToken}
          options={{
            action: 'reset',
            theme: 'light',
            size: 'normal',
          }}
        />
      )}
    </form>
  )
}

export default ResetPage
