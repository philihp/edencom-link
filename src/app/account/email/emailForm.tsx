'use client'

import { useState } from 'react'

import Dot from '../settings/dot'
import { updateEmail } from './actions'

// currentEmail is null for accounts that only have an SSO placeholder address.
const EmailForm = ({ currentEmail }: { currentEmail: string | null }) => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')
  const [disabled, setDisabled] = useState(false)

  const updateAndReturn = async (formData: FormData) => {
    const error = await updateEmail(formData)
    if (error) {
      setDisabled(false)
      setColor('#FF0000')
      setResponse(error)
      return
    }
    setColor('#00AF00')
    setResponse('A perfect time to check your email inbox for a confirmation link.')
  }

  return (
    <form
      onSubmit={() => {
        setResponse('')
        setDisabled(true)
      }}
    >
      <h1>Email address</h1>
      {currentEmail ? (
        <p>
          Your account&rsquo;s email is <strong>{currentEmail}</strong>. Enter a new address to change it — it takes
          effect once you confirm from your inbox.
        </p>
      ) : (
        <p>
          Your account doesn&rsquo;t have an email address yet. Adding one lets you log in with email and password too,
          and gives you a way back in if SSO ever fails you. It takes effect once you confirm from your inbox.
        </p>
      )}
      <label htmlFor="email">Email:</label>
      <br />
      <input id="email" name="email" type="email" required onChange={() => setDisabled(false)} />
      <br />
      <label htmlFor="password">Password (optional{currentEmail ? ', sets a new one' : ''}):</label>
      <br />
      <input id="password" name="password" type="password" />
      <br />
      <label htmlFor="confirm">Confirm password:</label>
      <br />
      <input id="confirm" name="confirm" type="password" />
      <br />
      <button formAction={updateAndReturn} disabled={disabled}>
        {currentEmail ? 'Change email' : 'Add email'}
      </button>
      {response && <Dot color={color} response={response} />}
    </form>
  )
}

export default EmailForm
