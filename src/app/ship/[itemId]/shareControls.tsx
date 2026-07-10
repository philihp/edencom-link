'use client'

import { useState, useTransition } from 'react'

import { createShareToken, revokeShareToken } from './actions'

type ShareControlsProps = {
  itemId: string
  // The caller's existing share token for this item, if one was already minted.
  initialToken: string | null
}

// Share-link controls for a ship the signed-in user owns: mint a public
// /ship/[itemId]?token=… link anyone can open, copy it, revoke it.
export const ShareControls = ({ itemId, initialToken }: ShareControlsProps) => {
  const [token, setToken] = useState(initialToken)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const shareUrl = token
    ? `${typeof window === 'undefined' ? '' : window.location.origin}/ship/${itemId}?token=${token}`
    : null

  const share = () =>
    startTransition(async () => {
      setError(null)
      const result = await createShareToken(itemId)
      if (result.error) setError(result.error)
      else setToken(result.token ?? null)
    })

  const revoke = () =>
    startTransition(async () => {
      setError(null)
      const result = await revokeShareToken(itemId)
      if (result.error) setError(result.error)
      else {
        setToken(null)
        setCopied(false)
      }
    })

  const copy = async () => {
    if (!shareUrl) return
    await navigator.clipboard.writeText(shareUrl)
    setCopied(true)
  }

  return (
    <p>
      {shareUrl ? (
        <>
          <code>{shareUrl}</code>{' '}
          <button type="button" onClick={copy} disabled={pending}>
            {copied ? 'copied' : 'copy'}
          </button>{' '}
          <button type="button" onClick={revoke} disabled={pending}>
            revoke
          </button>
        </>
      ) : (
        <button type="button" onClick={share} disabled={pending}>
          Share this ship
        </button>
      )}
      {error ? <span> {error}</span> : null}
    </p>
  )
}
