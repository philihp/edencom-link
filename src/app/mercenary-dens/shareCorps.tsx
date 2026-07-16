'use client'

import { useState, useTransition } from 'react'

import { setSharedCorps } from './actions'
import styles from './mercenaryDens.module.css'

type Corp = { id: string; name: string }

// Top-of-page control: pick which of your corporations to share your
// Mercenary Den data with — both your deployed dens and any enemy-den intel
// you report. Each corp is a checkbox; toggling one optimistically updates the
// selection and persists the whole set via the server action (which
// reconciles character_mercenary_den_share rows), reverting on error.
const ShareCorps = ({ corporations, sharedCorpIds }: { corporations: Corp[]; sharedCorpIds: string[] }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set(sharedCorpIds))
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

  const onToggle = (corpId: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(corpId)
    else next.delete(corpId)
    setSelected(next)
    setError('')
    startTransition(async () => {
      const result = await setSharedCorps([...next].map(Number))
      if (result.error) {
        setSelected(selected)
        setError(result.error)
      }
    })
  }

  if (corporations.length === 0) {
    return <span className={styles.shareStatus}>Add a character to share your dens with a corp.</span>
  }

  return (
    <div className={styles.shareCorps}>
      <span className={styles.shareCorpsLabel}>Share my dens &amp; intel with:</span>
      <div className={styles.shareCorpsList}>
        {corporations.map((corp) => (
          <label key={corp.id} className={styles.shareCorp}>
            <input
              type="checkbox"
              checked={selected.has(corp.id)}
              onChange={(e) => onToggle(corp.id, e.target.checked)}
              disabled={pending}
            />
            <span>{corp.name}</span>
          </label>
        ))}
      </div>
      {error && <span className={styles.shareError}>{error}</span>}
    </div>
  )
}

export default ShareCorps
