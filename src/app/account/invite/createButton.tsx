'use client'

import { useState } from 'react'

import Dot from '../settings/dot'
import { createInviteCode } from './actions'

// `available` is how many slots the schedule has granted but the user hasn't
// minted yet; the button is hidden by the parent when it's zero. Chancellors
// pass `unlimited` instead, which drops the count and is always shown.
const CreateButton = ({ available, unlimited = false }: { available?: number; unlimited?: boolean }) => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const create = async () => {
    const result = await createInviteCode()
    if (result.error) {
      setColor('#FF0000')
      setResponse(result.error)
      return
    }
    setColor('#00AF00')
    setResponse(`Created invite code ${result.code}`)
  }

  return (
    <>
      <form>
        <button formAction={create}>
          {unlimited ? 'Create invite code' : `Create invite code (${available} available)`}
        </button>
      </form>
      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default CreateButton
