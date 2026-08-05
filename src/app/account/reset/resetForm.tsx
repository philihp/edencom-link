'use client'

import { useState } from 'react'
import Link from 'next/link'

import styles from '../auth.module.css'
import Status from '../status'
import SubmitButton from '../submitButton'
import { reset } from './actions'

export const ResetForm = () => {
  // Doubles as the resubmit gate: the button stays off while the "check your
  // email" line is up, and editing the address clears both.
  const [sent, setSent] = useState(false)
  // Controlled so the address survives React's post-action form reset — it's
  // the confirmation line's subject, so it should still be on screen.
  const [email, setEmail] = useState('')

  const resetAndReturn = async (formData: FormData) => {
    await reset(formData)
    setSent(true)
  }

  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Reset password</h1>
        <p className={styles.intro}>
          Forgot your password? Confirm your email address and we&rsquo;ll send you a link to set a new one.
        </p>

        <form onSubmit={() => setSent(false)}>
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
                onChange={(e) => {
                  setEmail(e.target.value)
                  setSent(false)
                }}
              />
            </div>
          </div>

          <SubmitButton formAction={resetAndReturn} disabled={sent} pendingLabel="Sending…">
            Send email
          </SubmitButton>

          <div aria-live="polite">{sent && <Status kind="ok">Check your email for a link.</Status>}</div>
        </form>

        <div className={styles.footer}>
          <Link href="/account/login">Back to log in</Link>
        </div>
      </div>
    </main>
  )
}
