'use client'

import { useState } from 'react'

import Dot from '../dot'
import { impersonate } from './impersonate'

// On success this navigates away (the server action redirects home with the
// impersonated session), so the only outcome this form ever renders itself is
// an error.
const ImpersonateForm = () => {
  const [error, setError] = useState('')

  const submit = async (formData: FormData) => {
    const result = await impersonate(formData)
    setError(result?.error ?? '')
  }

  return (
    <>
      <form>
        <label htmlFor="userId">User ID: </label>
        <input id="userId" name="userId" type="text" required /> <button formAction={submit}>Impersonate</button>
      </form>
      <p>{error && <Dot color="#FF0000" response={error} />}</p>
    </>
  )
}

export default ImpersonateForm
