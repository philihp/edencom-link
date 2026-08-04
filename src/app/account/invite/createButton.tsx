'use client'

import { useState } from 'react'

import Dot from '../settings/dot'
import { createInviteCode } from './actions'
import CopyLink from './copyLink'

// `available` is how many slots the schedule has granted but the user hasn't
// minted yet; the button is hidden by the parent when it's zero. Chancellors
// pass `unlimited` instead, which drops the count and is always shown.
const CreateButton = ({ available, unlimited = false }: { available?: number; unlimited?: boolean }) => {
  const [error, setError] = useState('')
  const [created, setCreated] = useState('')

  const create = async () => {
    const result = await createInviteCode()
    if (result.error) {
      setError(result.error)
      setCreated('')
      return
    }
    setError('')
    setCreated(result.code ?? '')
  }

  return (
    <>
      <form>
        <button formAction={create}>
          {unlimited ? 'Create invite code' : `Create invite code (${available} available)`}
        </button>
      </form>
      <p>
        {error && <Dot color="#FF0000" response={error} />}
        {created && (
          <>
            <Dot color="#00AF00" response="Created " />
            <CopyLink code={created} />
          </>
        )}
      </p>
    </>
  )
}

export default CreateButton
