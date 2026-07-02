'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { INDEX_WINDOW_OPTIONS } from './windows'
import styles from './indexes.module.css'

// The page-level time-window dropdown, floated right of the "Indexes" title —
// same control as the Market page's. The window lives in the URL (?days=N) so
// the server component refetches exactly the span it needs.
export const WindowSelect = ({ days }: { days: number }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <label className={styles.windowSelect} data-pending={pending || undefined}>
      <span className={styles.srOnly}>Window</span>
      <select
        value={days}
        onChange={(e) => {
          const next = Number(e.target.value)
          startTransition(() => router.replace(`/indexes?days=${next}`, { scroll: false }))
        }}
      >
        {INDEX_WINDOW_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
