'use client'

import { useState } from 'react'

import Dot from '../settings/dot'
import { grantChancellor } from './actions'

// Form to promote another account to Chancellor by one of its character names.
const GrantForm = () => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const submit = async (formData: FormData) => {
    const result = await grantChancellor(formData)
    if (result.error) {
      setColor('#FF0000')
      setResponse(result.error)
      return
    }
    setColor('#00AF00')
    setResponse(result.ok ?? 'Done')
  }

  return (
    <>
      <form>
        <label htmlFor="name">Character name: </label>
        <input id="name" name="name" type="text" required /> <button formAction={submit}>Make Chancellor</button>
      </form>
      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default GrantForm
