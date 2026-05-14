'use client'

import { logoff } from './actions'

export const LogoffButton = () => {
  const logoffAction = async () => {
    await logoff()
  }

  return (
    <form>
      <button formAction={logoffAction}>Logoff</button>
    </form>
  )
}
