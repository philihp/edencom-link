'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import Dot from '../settings/dot'
import { lookupInvite, register, type InviteLookup } from './actions'
import { INVITE_CODE_PATTERN } from './inviteCode'

const RegisterForm = () => {
  const urlInvite = useSearchParams().get('invite')?.trim() ?? ''

  const [invite, setInvite] = useState(urlInvite)
  // A code arriving via the URL renders read-only; "use a different code"
  // unlocks it (needed when a shared link's code turns out to be spent).
  const [locked, setLocked] = useState(urlInvite !== '')
  const [lookup, setLookup] = useState<InviteLookup | null>(null)
  const lookupSeq = useRef(0)

  const [disabled, setDisabled] = useState(false)
  const [color, setColor] = useState('#000000')
  const [response, setResponse] = useState('')

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
      setDisabled(false)
      setResponse(error?.message)
      setColor('#FF0000')
      return
    }

    setResponse('A perfect time to check your email inbox.')
    setColor('#00AF00')
  }

  const handleEmailChange = () => {
    setDisabled(false)
  }

  return (
    <form
      onSubmit={() => {
        setResponse('')
        setDisabled(true)
      }}
    >
      <h1>Register</h1>
      <p>Create an account to manage your hangars. Registration is invite-only.</p>
      <p>
        In The Imperium? <a href="/account/gice">Register with your GICE account</a> instead — no email needed, though
        you&rsquo;ll still enter an invite code.
      </p>
      <label htmlFor="invite">Invite code:</label>
      <br />
      {/* readOnly, not disabled — a disabled input is dropped from FormData on submit */}
      <input
        id="invite"
        name="invite"
        type="text"
        required
        readOnly={locked}
        value={invite}
        style={locked ? { backgroundColor: '#eeeeee' } : undefined}
        onChange={(e) => {
          setInvite(e.target.value)
          handleEmailChange()
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
      {locked && (
        <>
          {' '}
          <button type="button" onClick={() => setLocked(false)}>
            use a different code
          </button>
        </>
      )}
      <br />
      <label htmlFor="email">Email:</label>
      <br />
      <input id="email" name="email" type="email" required onChange={handleEmailChange} />
      <br />
      <label htmlFor="password">Password:</label>
      <br />
      <input id="password" name="password" type="password" required />
      <br />
      <button formAction={signupAndReturn} disabled={disabled}>
        Register
      </button>
      {response && <Dot color={color} response={response} />}
    </form>
  )
}

export default RegisterForm
