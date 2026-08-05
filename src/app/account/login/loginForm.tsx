'use client'

import { useState } from 'react'
import { redirect } from 'next/navigation'

import { login } from './actions'

// The login form proper; the page (a server component) passes a sanitized
// same-site `next` path so flows like the OAuth consent page can bounce a
// logged-out user through login and back.
export const LoginForm = ({ next }: { next?: string }) => {
  const [response, setResponse] = useState<string>('')

  const loginAndReturn = async (formData: FormData) => {
    const error = await login(formData)
    if (error) {
      setResponse(error)
      return
    }
    redirect(next ?? '/')
  }

  return (
    <>
      <h1>Login</h1>
      <p>Login to access your hangar.</p>
      <form onSubmit={() => setResponse('')}>
        <label htmlFor="email">Email:</label>
        <br />
        <input id="email" name="email" type="email" required />
        <br />
        <label htmlFor="password">Password:</label>
        <br />
        <input id="password" name="password" type="password" required />
        <br />
        <button formAction={loginAndReturn}>Log in</button>
        {response && (
          <>
            <svg height="10" width="20">
              <circle cx="10" cy="5" r="5" fill="#FF0000" />
            </svg>
            {response}
          </>
        )}
        <div>
          <a href="reset">Forgot Password</a>
        </div>
      </form>
      <p>
        In The Imperium? <a href="/account/gice">Log in with GICE</a> instead.
      </p>
    </>
  )
}
