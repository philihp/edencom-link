'use client'

import { useState } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import styles from '../auth.module.css'
import Status from '../status'
import SubmitButton from '../submitButton'
import { login } from './actions'

// The login form proper; the page (a server component) passes a sanitized
// same-site `next` path so flows like the OAuth consent page can bounce a
// logged-out user through login and back.
export const LoginForm = ({ next }: { next?: string }) => {
  const [error, setError] = useState('')
  // Controlled so a rejected sign-in doesn't cost the address too: React resets
  // the form's uncontrolled fields once the action settles. The password is
  // left to clear, which is the conventional behaviour after a failure.
  const [email, setEmail] = useState('')

  const loginAndReturn = async (formData: FormData) => {
    const message = await login(formData)
    if (message) {
      setError(message)
      return
    }
    redirect(next ?? '/')
  }

  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Log in</h1>
        <p className={styles.intro}>Pick up where you left off — your hangars, wallets and industry jobs.</p>

        <form onSubmit={() => setError('')}>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="email">
                Email
              </label>
              <input
                className={styles.input}
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="password">
                Password
              </label>
              <input
                className={styles.input}
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
          </div>

          <SubmitButton formAction={loginAndReturn} pendingLabel="Logging in…">
            Log in
          </SubmitButton>

          {/* Present on every render so a screen reader announces the failure
              when it appears, rather than only on the next focus move. */}
          <div aria-live="polite">{error && <Status kind="error">{error}</Status>}</div>
        </form>

        <div className={styles.divider}>or</div>
        {/* A plain anchor, not next/link: /account/gice is a route handler that
            redirects out to the SSO, so it wants a real navigation. */}
        <a className={styles.alt} href="/account/gice">
          Log in with GICE
        </a>
        <p className={styles.altNote}>In The Imperium? Use your Goonfleet SSO account.</p>

        <div className={styles.footer}>
          <Link href="/account/register">Need an account?</Link>
          <Link href="/account/reset">Forgot password?</Link>
        </div>
      </div>
    </main>
  )
}
