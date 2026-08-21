'use client'

import { useState } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { signInWithEve } from '../../character/actions'
import styles from '../auth.module.css'
import Status from '../status'
import SubmitButton from '../submitButton'
import { login } from './actions'

// The login form proper; the page (a server component) passes a sanitized
// same-site `next` path so flows like the OAuth consent page can bounce a
// logged-out user through login and back.
export const LoginForm = ({ next }: { next?: string }) => {
  const [error, setError] = useState('')
  // Kept apart from the password form's error so one failure doesn't blank the
  // other's message.
  const [ssoError, setSsoError] = useState('')
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

  // The action redirects out to EVE on success, so anything it returns is a
  // failure to report.
  const signInAndReturn = async (formData: FormData) => {
    setSsoError('')
    const message = await signInWithEve(formData)
    if (message) setSsoError(message)
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
        {/* A form, not a link: starting the EVE round trip needs a session to
            hang the character on, and a Server Action is where that cookie
            write sticks (docs/open-registration.md). */}
        <form>
          <button className={styles.alt} formAction={signInAndReturn}>
            Log in with EVE Online
          </button>
        </form>
        <p className={styles.altNote}>
          No password needed — your character is the key. New here? This registers you too.
        </p>
        <div aria-live="polite">{ssoError && <Status kind="error">{ssoError}</Status>}</div>

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
