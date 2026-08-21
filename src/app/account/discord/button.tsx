'use client'

import { useState } from 'react'

import styles from '../auth.module.css'
import Status from '../status'
import { startDiscordAuth, unlinkDiscord } from './actions'

// The Discord entry point, wherever it appears: the two sign-on cards (where it
// wears the same face as the GICE button) and the settings page (where it is
// one control among many, so `plain` drops the full-width styling).
//
// A form rather than a link, for the reason every SSO start here is: the action
// needs the caller's session to decide between linking and signing in, and a
// Server Action is where the PKCE cookie it sets actually sticks.
export const DiscordButton = ({ label, next, plain }: { label: string; next?: string; plain?: boolean }) => {
  const [error, setError] = useState('')

  const start = async (formData: FormData) => {
    setError('')
    const message = await startDiscordAuth(formData)
    if (message) setError(message)
  }

  return (
    <>
      <form>
        <input type="hidden" name="next" value={next ?? '/'} />
        <button className={plain ? undefined : styles.alt} formAction={start}>
          {label}
        </button>
      </form>
      <div aria-live="polite">{error && <Status kind="error">{error}</Status>}</div>
    </>
  )
}

// Detaching it again, from settings. Supabase refuses to unlink the last
// identity an account has, and that refusal is what the message shows.
export const DiscordUnlinkButton = () => {
  const [error, setError] = useState('')

  const unlink = async () => {
    setError('')
    const message = await unlinkDiscord()
    if (message) setError(message)
  }

  return (
    <>
      <form>
        <button formAction={unlink}>Unlink Discord</button>
      </form>
      <div aria-live="polite">{error && <Status kind="error">{error}</Status>}</div>
    </>
  )
}
