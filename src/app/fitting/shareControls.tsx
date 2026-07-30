'use client'

import { useState, useTransition } from 'react'

import { createFittingShare, revokeFittingShare, type ShareLevel, type ShareRow } from './actions'
import styles from './fittings.module.css'

type ShareControlsProps = {
  // The owner's registration uuid, which is what character_fitting_share keys
  // on — not the EVE character id in the page's URL (resolveCharacter.ts
  // translates between them).
  registrationId: string
  fittingId: string
  initialShares: ShareRow[]
}

const LEVELS: Array<{ level: ShareLevel; on: string; off: string }> = [
  { level: 'corporation', on: 'Shared with corporation ✕', off: 'Share with corporation' },
  { level: 'alliance', on: 'Shared with alliance ✕', off: 'Share with alliance' },
  { level: 'public', on: 'Shared with everyone ✕', off: 'Share with everyone' },
]

// Share controls for a fit the signed-in user owns: one toggle per
// character_fitting_share level. No token and nothing to copy at any level —
// visibility is gated live by RLS on character_fitting_over_time (see
// schema.sql): corp/alliance shares open the fit to current mates, a public
// share to any signed-in user, all at this same URL. At most one row per
// level, so each button just flips its row on and off. (Anonymous no-login
// share links are a future design; the table's token column is a placeholder
// for it.)
export const ShareControls = ({ registrationId, fittingId, initialShares }: ShareControlsProps) => {
  const [shares, setShares] = useState(initialShares)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const share = (level: ShareLevel) =>
    startTransition(async () => {
      setError(null)
      const result = await createFittingShare(registrationId, fittingId, level)
      if (result.error || !result.share) {
        setError(result.error ?? 'Could not create share')
        return
      }
      setShares((prev) => [...prev, result.share as ShareRow])
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
    })

  return (
    <div className={styles.shareRow}>
      {LEVELS.map(({ level, on, off }) => {
        const existing = shares.find((s) => s.level === level)
        return (
          <button
            key={level}
            type="button"
            className={styles.shareButton}
            onClick={() => (existing ? revoke(existing) : share(level))}
            disabled={pending}
          >
            {existing ? on : off}
          </button>
        )
      })}
      {error ? <span> {error}</span> : null}
    </div>
  )
}
