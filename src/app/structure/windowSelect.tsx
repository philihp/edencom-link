'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { STRUCTURE_WINDOW_OPTIONS } from './windows'
import styles from './structures.module.css'

// The time-window dropdown pinned to the top-right of the Structures page — the
// same control as the Market/Indexes pages. It scopes both the revenue footer
// (per-structure Revenue, unaccounted tax, clone revenue) and the industry-index
// sparklines. The window lives in the URL (?days=N) so the server component
// refetches exactly the span it needs.
//
// `path` lets the structure detail page reuse the control for its own Tax
// Revenue table; it defaults to the Structures page it was written for.
export const WindowSelect = ({ days, path = '/structure' }: { days: number; path?: string }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <label className={styles.windowSelect} data-pending={pending || undefined}>
      <span className={styles.srOnly}>Time window</span>
      <select
        value={days}
        onChange={(e) => {
          const next = Number(e.target.value)
          startTransition(() => router.replace(`${path}?days=${next}`, { scroll: false }))
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
