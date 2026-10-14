'use client'

import { useOptimistic, useState, useTransition } from 'react'

import { setAllianceShareDefault } from './shareActions'
import type { AllianceShareDefault } from './shareData'
import styles from './structures.module.css'

// The Directors-only toggle on /structure, one per directed corporation in an
// alliance: "Share all structures with <alliance>" — the seeded default of
// docs/sharing-layer/12-structure-share.md, visible and revocable. Off deletes
// the corporation-wide share row (the opt-out the extract respects); on puts
// it back as the seeded default, so it follows the corp's alliance again.
const Toggle = ({ item }: { item: AllianceShareDefault }) => {
  const [pending, startTransition] = useTransition()
  const [optimistic, setOptimistic] = useOptimistic(item.enabled)
  const [error, setError] = useState<string | null>(null)
  return (
    <label className={styles.shareToggle} data-pending={pending || undefined}>
      <input
        type="checkbox"
        checked={optimistic}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked
          startTransition(async () => {
            setOptimistic(next)
            setError(null)
            const result = await setAllianceShareDefault(item.corporationId, next)
            if (result.error) setError(result.error)
          })
        }}
      />
      <span>
        share all of {item.corporationName}&rsquo;s structures with {item.allianceName}
        {error ? <span className={styles.shareToggleError}> — {error}</span> : null}
      </span>
    </label>
  )
}

export const AllianceShareToggles = ({ items }: { items: AllianceShareDefault[] }) =>
  items.length === 0 ? null : (
    <div className={styles.shareToggles}>
      {items.map((item) => (
        <Toggle key={item.corporationId} item={item} />
      ))}
    </div>
  )
