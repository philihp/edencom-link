'use client'

import { useEffect, useRef, useState } from 'react'
import { redirect } from 'next/navigation'

import { lookupInvite, type InviteLookup } from '../../register/actions'
import { INVITE_CODE_PATTERN } from '../../register/inviteCode'
import Dot from '../../settings/dot'
import { completeGiceRegistration } from './actions'

// Invite code entry for a freshly verified GICE identity. Mirrors the live
// inviter lookup on the email register form, minus the email/password fields.
const CompleteForm = ({ name }: { name: string | null }) => {
  const [invite, setInvite] = useState('')
  const [lookup, setLookup] = useState<InviteLookup | null>(null)
  const lookupSeq = useRef(0)

  const [disabled, setDisabled] = useState(false)
  const [response, setResponse] = useState('')

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
    const error = await completeGiceRegistration(formData)
    if (error) {
      setDisabled(false)
      setResponse(error)
      return
    }
    redirect('/')
  }

  return (
    <form
      onSubmit={() => {
        setResponse('')
        setDisabled(true)
      }}
    >
      <h1>Almost there{name ? `, ${name}` : ''}</h1>
      <p>
        Your GICE login checks out. Edencom Link is invite-only, so one last thing: an invite code creates your account.
      </p>
      <label htmlFor="invite">Invite code:</label>
      <br />
      <input
        id="invite"
        name="invite"
        type="text"
        required
        value={invite}
        onChange={(e) => {
          setInvite(e.target.value)
          setDisabled(false)
        }}
      />{' '}
      {lookup?.status === 'valid' && (
        <Dot
          color="#00AF00"
          response={lookup.inviterName ? `Invited by ${lookup.inviterName}` : 'A founding invite code'}
        />
      )}
      {lookup?.status === 'redeemed' && <Dot color="#FF0000" response="This invite code has already been used." />}
      {lookup?.status === 'unknown' && <Dot color="#FF0000" response="This invite code isn’t recognized." />}
      <br />
      <button formAction={completeAndReturn} disabled={disabled}>
        Create account
      </button>
      {response && <Dot color="#FF0000" response={response} />}
    </form>
  )
}

export default CompleteForm
