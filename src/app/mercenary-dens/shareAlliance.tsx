'use client'

import { useState, useTransition } from 'react'

import { setSharedAlliances } from './actions'
import styles from './mercenaryDens.module.css'

type Alliance = { id: string; name: string }

// Top-of-page control: pick which of your alliances to share your Mercenary Den
// data with — both your deployed dens and any enemy-den intel you report.
// Sharing is opt-in, so nothing is shared until something here is ticked. The
// options are the alliances your own characters are in, which for most people is
// exactly one. Toggling optimistically updates the selection and persists the
// whole set via the server action (which reconciles
// character_mercenary_den_share rows), reverting on error.
const ShareAlliance = ({ alliances, sharedAllianceIds }: { alliances: Alliance[]; sharedAllianceIds: string[] }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set(sharedAllianceIds))
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

  const onToggle = (allianceId: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(allianceId)
    else next.delete(allianceId)
    setSelected(next)
    setError('')
    startTransition(async () => {
      const result = await setSharedAlliances([...next].map(Number))
      if (result.error) {
        setSelected(selected)
        setError(result.error)
      }
    })
  }

  if (alliances.length === 0) {
    return <span className={styles.shareStatus}>Add a character in an alliance to share your dens.</span>
  }

  return (
    <div className={styles.share}>
      <span className={styles.shareLabel}>Share my dens &amp; intel with:</span>
      <div className={styles.shareList}>
        {alliances.map((alliance) => (
          <label key={alliance.id} className={styles.shareToggle}>
            <input
              type="checkbox"
              checked={selected.has(alliance.id)}
              onChange={(e) => onToggle(alliance.id, e.target.checked)}
              disabled={pending}
            />
            <span className={styles.shareAudience}>{alliance.name}</span>
          </label>
        ))}
      </div>
      {error && <span className={styles.shareError}>{error}</span>}
    </div>
  )
}

export default ShareAlliance
