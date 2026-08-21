'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import styles from '../auth.module.css'
import { DiscordButton } from '../discord/button'
import Status from '../status'
import SubmitButton from '../submitButton'
import { lookupInvite, register, type InviteLookup } from './actions'
import { INVITE_CODE_PATTERN } from './inviteCode'

type Result = { kind: 'ok' | 'error'; message: string }

// Structurally the lib/referral `Referral`, restated rather than imported: that
// module reaches a Supabase factory, and a client component may not pull one
// into its graph (see the Server-Timing note in CLAUDE.md).
type Referral = { referred: boolean; inviterName: string | null }

// Registration is open (docs/open-registration.md), so the invite field is no
// longer the first thing anyone meets — "Have an invite code?" sits in the
// footer beside the login link, and answering it slides the field open. A code
// arriving in the URL from a shared link opens it without being asked, and an
// account that already carries a referral gets a line instead of a field (one
// referral per account, so there is nothing left to enter).
const RegisterForm = ({ referral, discordEnabled }: { referral: Referral; discordEnabled?: boolean }) => {
  const urlInvite = useSearchParams().get('invite')?.trim() ?? ''

  const [invite, setInvite] = useState(urlInvite)
  // Controlled for the same reason the invite code is: React resets the form's
  // uncontrolled fields once the action settles, and a rejected sign-up
  // shouldn't cost the address as well. The password is left to clear.
  const [email, setEmail] = useState('')
  // A code arriving via the URL renders read-only; "use a different code"
  // unlocks it (needed when a shared link's code turns out to be spent).
  const [locked, setLocked] = useState(urlInvite !== '')
  // Two pieces of state, not one, because the field has to animate both ways:
  // `mounted` keeps it in the tree long enough for the closing transition to
  // run, `open` is the class that drives it. A code from the URL starts open,
  // and skips the entrance — there was no click to answer.
  const [inviteMounted, setInviteMounted] = useState(urlInvite !== '')
  const [inviteOpen, setInviteOpen] = useState(urlInvite !== '')
  const [lookup, setLookup] = useState<InviteLookup | null>(null)
  const lookupSeq = useRef(0)
  const inviteRef = useRef<HTMLInputElement>(null)

  // Stays true after a successful sign-up so the button can't be hit twice;
  // editing any field clears it, which is how a rejected email gets retried.
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  // Mount closed, then open on the next frame: a node that appears already open
  // has nothing to transition from, and the entrance would be lost.
  const openInvite = () => {
    setInviteMounted(true)
    requestAnimationFrame(() => setInviteOpen(true))
  }

  // Leaving an empty field puts it away again — the footer link comes back and
  // the form is tidy for someone who clicked it by accident. A field with
  // anything typed in it stays: closing it would drop the code (an unmounted
  // input is not in the submitted FormData), and losing a referral silently is
  // worse than a box left open.
  const closeInviteIfEmpty = () => {
    if (invite.trim() === '') setInviteOpen(false)
  }

  // Focus follows the click, so the field can be typed into straight away.
  useEffect(() => {
    if (inviteOpen && urlInvite === '') inviteRef.current?.focus()
  }, [inviteOpen, urlInvite])

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
          Create an account to manage your hangars. Anyone may register — an invite code, if you have one, credits
          whoever sent you.
        </p>

        <form
          onSubmit={() => {
            setResult(null)
            setSubmitted(true)
          }}
        >
          <div className={styles.fields}>
            {referral.referred
              ? referral.inviterName && (
                  <Status kind="ok" inline>
                    Referred by {referral.inviterName}
                  </Status>
                )
              : /* The closing transition is what defers the unmount, so the
                   field survives long enough to ease away; any one of the
                   animated properties finishing is enough to know it is over. */
                inviteMounted && (
                  <div
                    className={`${styles.reveal} ${inviteOpen ? styles.revealOpen : ''}`}
                    onTransitionEnd={() => {
                      if (!inviteOpen) setInviteMounted(false)
                    }}
                  >
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
                        readOnly={locked}
                        ref={inviteRef}
                        value={invite}
                        onBlur={closeInviteIfEmpty}
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
                  </div>
                )}

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
        <p className={styles.altNote}>In The Imperium? No email needed — your Goonfleet SSO account is enough.</p>

        {discordEnabled && (
          <>
            <DiscordButton label="Register with Discord" />
            <p className={styles.altNote}>No email or password to remember — your Discord account signs you in.</p>
          </>
        )}

        <div className={styles.footer}>
          <Link href="/account/login">Already have an account?</Link>
          {/* Not a field any more but a question, asked where the other
              question is asked — nobody needs an invite code, so it belongs at
              the end rather than in the way. */}
          {!referral.referred && !inviteOpen && (
            <button type="button" className={styles.linkButton} onClick={openInvite}>
              Have an invite code?
            </button>
          )}
        </div>
      </div>
    </main>
  )
}

export default RegisterForm
