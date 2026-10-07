'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { TIME_WINDOW_OPTIONS } from './timeWindow'
import styles from './windowSelect.module.css'

// The trailing-days dropdown (timeWindow.ts), in the two ways a page holds
// its window. WindowSelect is the bare control for a page that keeps the
// window in state (Market, Industry); UrlWindowSelect writes it to `?days=N`
// for a page whose server component refetches exactly that span (Indexes,
// Structures). Both carry their own screen-reader label, so the page's
// visible "Window" label — where it has one — is a plain span, never a
// second <label>.

const CUSTOM = 'custom'

type WindowSelectProps = {
  days: number
  onChange: (days: number) => void
  // The window has been zoomed or panned off every offered span: the control
  // reads "custom" until the next pick.
  custom?: boolean
  pending?: boolean
}

export const WindowSelect = ({ days, onChange, custom = false, pending = false }: WindowSelectProps) => (
  <label className={styles.windowSelect} data-pending={pending || undefined}>
    <span className={styles.srOnly}>Time window</span>
    <select value={custom ? CUSTOM : days} onChange={(e) => onChange(Number(e.target.value))}>
      {TIME_WINDOW_OPTIONS.map((o) => (
        <option key={o.days} value={o.days}>
          {o.label}
        </option>
      ))}
      {custom && (
        <option value={CUSTOM} disabled>
          custom
        </option>
      )}
    </select>
  </label>
)

export const UrlWindowSelect = ({ days, path }: { days: number; path: string }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <WindowSelect
      days={days}
      pending={pending}
      onChange={(next) => startTransition(() => router.replace(`${path}?days=${next}`, { scroll: false }))}
    />
  )
}
