'use client'

import { useState, useTransition } from 'react'

import { setDenSharing } from './actions'
import styles from './mercenaryDens.module.css'

// Top-of-page control: whether to share your Mercenary Den data — both your
// deployed dens and any enemy-den intel you report — with your alliance. There's
// no audience to pick: it's derived from the corporations and alliances your own
// characters belong to (see mercenary_den_visible_registrations in schema.sql),
// and it's on by default, so this is a single opt-out checkbox. Toggling
// optimistically updates the checkbox and persists via the server action
// (which adds/removes the caller's mercenary_den_share_opt_out row), reverting
// on error.
const ShareAlliance = ({ audience, shared }: { audience: string | null; shared: boolean }) => {
  const [checked, setChecked] = useState(shared)
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

  const onToggle = (next: boolean) => {
    setChecked(next)
    setError('')
    startTransition(async () => {
      const result = await setDenSharing(next)
      if (result.error) {
        setChecked(!next)
        setError(result.error)
      }
    })
  }

  if (!audience) {
    return <span className={styles.shareStatus}>Add a character to share your dens with your alliance.</span>
  }

  return (
    <div className={styles.share}>
      <label className={styles.shareToggle}>
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} disabled={pending} />
        <span>
          Share my dens &amp; intel with <span className={styles.shareAudience}>{audience}</span>
        </span>
      </label>
      {error && <span className={styles.shareError}>{error}</span>}
    </div>
  )
}

export default ShareAlliance
