'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'

import { createFittingShare, revokeFittingShare, type ShareLevel, type ShareRow } from './actions'
import styles from './fittings.module.css'

type ShareControlsProps = {
  characterId: string
  fittingId: string
  initialShares: ShareRow[]
}

// Share controls for a fit the signed-in user owns, at all three levels
// character_fitting_share supports:
//
//   - corporation / alliance: a toggle each. No token — visibility is gated
//     live by RLS on character_fitting_over_time (see schema.sql), so there's
//     at most one row per level and nothing to copy; the button just reads
//     "shared" once the row exists.
//   - public: a list, since a player can hand out several independently
//     revocable links (no uniqueness on the row). Minting one rewrites the
//     owner's own address bar to /fitting/[characterId]/[fittingId]?token=…
//     via router.replace — the owner's tab ends up showing exactly the link
//     they'd copy to hand to someone else. Revoking the token currently in
//     the URL clears it back to the bare path.
export const ShareControls = ({ characterId, fittingId, initialShares }: ShareControlsProps) => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [shares, setShares] = useState(initialShares)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const path = `/fitting/${characterId}/${fittingId}`
  const currentToken = searchParams.get('token')

  const corpShare = shares.find((s) => s.level === 'corporation')
  const allianceShare = shares.find((s) => s.level === 'alliance')
  const publicShares = shares.filter((s) => s.level === 'public')

  const share = (level: ShareLevel) =>
    startTransition(async () => {
      setError(null)
      const result = await createFittingShare(characterId, fittingId, level)
      if (result.error || !result.share) {
        setError(result.error ?? 'Could not create share')
        return
      }
      setShares((prev) => [...prev, result.share as ShareRow])
      if (level === 'public' && result.share.token) {
        router.replace(`${path}?token=${result.share.token}`, { scroll: false })
      }
    })

  const revoke = (row: ShareRow) =>
    startTransition(async () => {
      setError(null)
      const result = await revokeFittingShare(row.id)
      if (result.error) {
        setError(result.error)
        return
      }
      setShares((prev) => prev.filter((s) => s.id !== row.id))
      if (row.token && row.token === currentToken) router.replace(path, { scroll: false })
    })

  const copy = async (row: ShareRow) => {
    if (!row.token) return
    await navigator.clipboard.writeText(
      `${typeof window === 'undefined' ? '' : window.location.origin}${path}?token=${row.token}`
    )
    setCopiedId(row.id)
  }

  return (
    <div className={styles.shareControls}>
      <div className={styles.shareRow}>
        <button
          type="button"
          className={styles.shareButton}
          onClick={() => (corpShare ? revoke(corpShare) : share('corporation'))}
          disabled={pending}
        >
          {corpShare ? 'Shared with corporation ✕' : 'Share with corporation'}
        </button>
        <button
          type="button"
          className={styles.shareButton}
          onClick={() => (allianceShare ? revoke(allianceShare) : share('alliance'))}
          disabled={pending}
        >
          {allianceShare ? 'Shared with alliance ✕' : 'Share with alliance'}
        </button>
        <button type="button" className={styles.shareButton} onClick={() => share('public')} disabled={pending}>
          + New public link
        </button>
        {error ? <span> {error}</span> : null}
      </div>

      {publicShares.length > 0 ? (
        <ul className={styles.shareList}>
          {publicShares.map((row) => (
            <li key={row.id} className={styles.shareListItem}>
              <code className={styles.shareLink}>
                {typeof window === 'undefined' ? '' : window.location.origin}
                {path}?token={row.token}
              </code>
              <button type="button" className={styles.shareButton} onClick={() => copy(row)} disabled={pending}>
                {copiedId === row.id ? 'copied' : 'copy'}
              </button>
              <button type="button" className={styles.shareButton} onClick={() => revoke(row)} disabled={pending}>
                revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
