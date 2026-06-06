'use client'

import { useState } from 'react'

import { register } from './actions'

const RegisterPage = () => {
  const [disabled, setDisabled] = useState(false)
  const [color, setColor] = useState('#000000')
  const [response, setResponse] = useState('')

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
      <label htmlFor="invite">Invite code:</label>
      <br />
      <input id="invite" name="invite" type="text" required onChange={handleEmailChange} />
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
      {response && (
        <>
          <svg height="10" width="20">
            <circle cx="10" cy="5" r="5" fill={color} />
          </svg>
          {response}
        </>
      )}
    </form>
  )
}

export default RegisterPage
