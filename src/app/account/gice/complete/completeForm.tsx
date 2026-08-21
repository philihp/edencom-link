'use client'

import { useEffect, useRef, useState } from 'react'
import { redirect } from 'next/navigation'

import styles from '../../auth.module.css'
import Status from '../../status'
import SubmitButton from '../../submitButton'
import { lookupInvite, type InviteLookup } from '../../register/actions'
import { INVITE_CODE_PATTERN } from '../../register/inviteCode'
import { completeGiceRegistration } from './actions'

// The last step of a GICE registration. There is nothing required to fill in —
// the identity is already proved — so the invite field sits behind a link, the
// way it does on the email register form, and only records a referral. Keeps
// that form's live inviter lookup for a code that is entered.
const CompleteForm = ({ name }: { name: string | null }) => {
  const [invite, setInvite] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [lookup, setLookup] = useState<InviteLookup | null>(null)
  const lookupSeq = useRef(0)

  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const seq = ++lookupSeq.current
    if (!INVITE_CODE_PATTERN.test(invite)) {
      setLookup(null)
      return undefined
    }
    const timer = setTimeout(async () => {
      const result = await lookupInvite(invite)
      if (seq === lookupSeq.current) setLookup(result)
    }, 500)
    return () => clearTimeout(timer)
  }, [invite])

  const completeAndReturn = async (formData: FormData) => {
    const message = await completeGiceRegistration(formData)
    if (message) {
      setSubmitted(false)
      setError(message)
      return
    }
    redirect('/')
  }

  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Almost there{name ? `, ${name}` : ''}</h1>
        <p className={styles.intro}>
          Your GICE login checks out — that&rsquo;s all we need. Create your account and your hangars are a character
          away.
        </p>

        <form
          onSubmit={() => {
            setError('')
            setSubmitted(true)
          }}
        >
          <div className={styles.fields}>
            {showInvite ? (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="invite">
                  Invite code
                </label>
                <input
                  className={styles.input}
                  id="invite"
                  name="invite"
                  type="text"
                  autoComplete="off"
                  autoFocus
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
              </div>
            ) : (
              <button type="button" className={styles.linkButton} onClick={() => setShowInvite(true)}>
                No invite code required — but if you have one, enter it
              </button>
            )}
          </div>

          <SubmitButton formAction={completeAndReturn} disabled={submitted} pendingLabel="Creating account…">
            Create account
          </SubmitButton>

          <div aria-live="polite">{error && <Status kind="error">{error}</Status>}</div>
        </form>
      </div>
    </main>
  )
}

export default CompleteForm
