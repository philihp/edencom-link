'use client'

import { useState } from 'react'

import { revokeChancellor } from './actions'

// Revoke (or, for your own account, step down from) Chancellor. On success the
// server action revalidates the page, which re-renders the list without the row.
const RevokeButton = ({ userId, self = false }: { userId: string; self?: boolean }) => {
  const [error, setError] = useState('')

  const revoke = async () => {
    const result = await revokeChancellor(userId)
    if (result.error) setError(result.error)
  }

  return (
    <form style={{ display: 'inline' }}>
      <button formAction={revoke}>{self ? 'Step down' : 'Revoke'}</button>
      {error && <span> — {error}</span>}
    </form>
  )
}

export default RevokeButton
