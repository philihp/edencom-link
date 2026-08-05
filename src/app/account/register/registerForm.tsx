'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import styles from '../auth.module.css'
import Status from '../status'
import SubmitButton from '../submitButton'
import { lookupInvite, register, type InviteLookup } from './actions'
import { INVITE_CODE_PATTERN } from './inviteCode'

type Result = { kind: 'ok' | 'error'; message: string }

const RegisterForm = () => {
  const urlInvite = useSearchParams().get('invite')?.trim() ?? ''

  const [invite, setInvite] = useState(urlInvite)
  // Controlled for the same reason the invite code is: React resets the form's
  // uncontrolled fields once the action settles, and a rejected sign-up
  // shouldn't cost the address as well. The password is left to clear.
  const [email, setEmail] = useState('')
  // A code arriving via the URL renders read-only; "use a different code"
  // unlocks it (needed when a shared link's code turns out to be spent).
  const [locked, setLocked] = useState(urlInvite !== '')
  const [lookup, setLookup] = useState<InviteLookup | null>(null)
  const lookupSeq = useRef(0)

  // Stays true after a successful sign-up so the button can't be hit twice;
  // editing any field clears it, which is how a rejected email gets retried.
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  // Resolve the inviter as soon as the field holds a complete code — instantly
  // for the URL-provided one, debounced while typing. The sequence counter
  // makes the latest lookup win over a slower earlier one.
  useEffect(() => {
    const seq = ++lookupSeq.current
    if (!INVITE_CODE_PATTERN.test(invite)) {
      setLookup(null)
      return undefined
    }
    const timer = setTimeout(
      async () => {
        const result = await lookupInvite(invite)
        if (seq === lookupSeq.current) setLookup(result)
      },
      invite === urlInvite ? 0 : 500
    )
    return () => clearTimeout(timer)
  }, [invite, urlInvite])

  const signupAndReturn = async (formData: FormData) => {
    const { error } = await register(formData)
    if (error?.message) {
      setSubmitted(false)
      setResult({ kind: 'error', message: error.message })
      return
    }
    setResult({ kind: 'ok', message: 'A perfect time to check your email inbox.' })
  }

  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Register</h1>
        <p className={styles.intro}>
          Create an account to manage your hangars. Registration is invite-only — you&rsquo;ll need a code from someone
          already here.
        </p>

        <form
          onSubmit={() => {
            setResult(null)
            setSubmitted(true)
          }}
        >
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="invite">
                Invite code
              </label>
              {/* readOnly, not disabled — a disabled input is dropped from FormData on submit */}
              <input
                className={styles.input}
                id="invite"
                name="invite"
                type="text"
                autoComplete="off"
                autoFocus={urlInvite === ''}
                required
                readOnly={locked}
                value={invite}
                onChange={(e) => {
                  setInvite(e.target.value)
                  setSubmitted(false)
                }}
              />
              <div aria-live="polite">
                {lookup?.status === 'valid' && (
                  <Status kind="ok" inline>
                    {lookup.inviterName ? `Invited by ${lookup.inviterName}` : 'A founding invite code'}
                  </Status>
                )}
                {lookup?.status === 'redeemed' && (
                  <Status kind="error" inline>
                    This invite code has already been used.
                  </Status>
                )}
                {lookup?.status === 'unknown' && (
                  <Status kind="error" inline>
                    This invite code isn&rsquo;t recognized.
                  </Status>
                )}
              </div>
              {locked && (
                <button type="button" className={styles.linkButton} onClick={() => setLocked(false)}>
                  use a different code
                </button>
              )}
            </div>

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
                autoFocus={urlInvite !== ''}
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setSubmitted(false)
                }}
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
                autoComplete="new-password"
                required
              />
            </div>
          </div>

          <SubmitButton formAction={signupAndReturn} disabled={submitted} pendingLabel="Creating account…">
            Register
          </SubmitButton>

          <div aria-live="polite">{result && <Status kind={result.kind}>{result.message}</Status>}</div>
        </form>

        <div className={styles.divider}>or</div>
        {/* A plain anchor, not next/link: /account/gice is a route handler that
            redirects out to the SSO, so it wants a real navigation. */}
        <a className={styles.alt} href="/account/gice">
          Register with GICE
        </a>
        <p className={styles.altNote}>
          In The Imperium? No email needed — though you&rsquo;ll still enter an invite code.
        </p>

        <div className={styles.footer}>
          <Link href="/account/login">Already have an account?</Link>
        </div>
      </div>
    </main>
  )
}

export default RegisterForm
