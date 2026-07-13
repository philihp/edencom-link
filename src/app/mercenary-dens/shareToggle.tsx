'use client'

import { useState, useTransition } from 'react'

import { setShareMercenaryDens } from './actions'
import styles from './mercenaryDens.module.css'

// Top-of-page toggle: opts the signed-in user into sharing their deployed
// mercenary dens with corpmates. Optimistically flips, persists via the server
// action, and reverts + surfaces the message on error.
const ShareToggle = ({ initialShared }: { initialShared: boolean }) => {
  const [shared, setShared] = useState(initialShared)
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked
    setShared(next)
    setError('')
    startTransition(async () => {
      const result = await setShareMercenaryDens(next)
      if (result.error) {
        setShared(!next)
        setError(result.error)
      }
    })
  }

  return (
    <div className={styles.shareToggle}>
      <label className={styles.shareLabel}>
        <input type="checkbox" checked={shared} onChange={onChange} disabled={pending} />
        <span>Share my dens with my corp</span>
      </label>
      <span className={styles.shareStatus}>
        {error ? <span className={styles.shareError}>{error}</span> : shared ? 'Shared with corpmates' : 'Private'}
      </span>
    </div>
  )
}

export default ShareToggle
