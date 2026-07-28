'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { createFittingShareToken, revokeFittingShareToken } from './actions'
import styles from './fittings.module.css'

type ShareControlsProps = {
  characterId: string
  fittingId: string
  // The caller's existing share token for this fit, if one was already minted.
  initialToken: string | null
}

// Share-link controls for a fit the signed-in user owns: mint a public
// /fitting/[characterId]/[fittingId]?token=… link anyone can open without
// signing in, copy it, revoke it. Mirrors src/app/ship/[itemId]/shareControls.tsx,
// with one addition: minting/revoking also rewrites the browser's own address
// bar (router.replace, no navigation) to add/drop the token — the owner's own
// tab ends up showing exactly the link they'd hand to someone else.
export const ShareControls = ({ characterId, fittingId, initialToken }: ShareControlsProps) => {
  const router = useRouter()
  const [token, setToken] = useState(initialToken)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const path = `/fitting/${characterId}/${fittingId}`
  const shareUrl = token ? `${typeof window === 'undefined' ? '' : window.location.origin}${path}?token=${token}` : null

  const share = () =>
    startTransition(async () => {
      setError(null)
      const result = await createFittingShareToken(characterId, fittingId)
      if (result.error) {
        setError(result.error)
        return
      }
      setToken(result.token ?? null)
      if (result.token) router.replace(`${path}?token=${result.token}`, { scroll: false })
    })

  const revoke = () =>
    startTransition(async () => {
      setError(null)
      const result = await revokeFittingShareToken(characterId, fittingId)
      if (result.error) {
        setError(result.error)
        return
      }
      setToken(null)
      setCopied(false)
      router.replace(path, { scroll: false })
    })

  const copy = async () => {
    if (!shareUrl) return
    await navigator.clipboard.writeText(shareUrl)
    setCopied(true)
  }

  return (
    <p className={styles.shareRow}>
      {shareUrl ? (
        <>
          <code className={styles.shareLink}>{shareUrl}</code>
          <button type="button" className={styles.shareButton} onClick={copy} disabled={pending}>
            {copied ? 'copied' : 'copy'}
          </button>
          <button type="button" className={styles.shareButton} onClick={revoke} disabled={pending}>
            revoke
          </button>
        </>
      ) : (
        <button type="button" className={styles.shareButton} onClick={share} disabled={pending}>
          Share this fit
        </button>
      )}
      {error ? <span> {error}</span> : null}
    </p>
  )
}
