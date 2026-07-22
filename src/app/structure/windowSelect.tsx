'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { STRUCTURE_WINDOW_OPTIONS } from './windows'
import styles from './structures.module.css'

// The tax-revenue time-window dropdown shown in the Structures footer, next to
// the unaccounted-revenue figure — the same control as the Market/Indexes
// pages. The window lives in the URL (?days=N) so the server component refetches
// exactly the span it needs.
export const WindowSelect = ({ days }: { days: number }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <label className={styles.windowSelect} data-pending={pending || undefined}>
      <span className={styles.srOnly}>Revenue window</span>
      <select
        value={days}
        onChange={(e) => {
          const next = Number(e.target.value)
          startTransition(() => router.replace(`/structure?days=${next}`, { scroll: false }))
        }}
      >
        {STRUCTURE_WINDOW_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
