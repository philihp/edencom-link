'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

import styles from './fittings.module.css'

// The Personal / Corp / Alliance checkboxes on /fitting. Which sources are
// shown lives in the URL (?personal=0 turns one off; absent means on) so the
// server component fetches exactly the sources it needs and the view survives
// a reload or a shared link — the same URL-state pattern as /structure's
// window select.
export const SCOPE_TOGGLES = [
  { param: 'personal', label: 'Personal' },
  { param: 'corp', label: 'Corp' },
  { param: 'alliance', label: 'Alliance' },
] as const

export type ScopeParam = (typeof SCOPE_TOGGLES)[number]['param']

export const ScopeToggles = () => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const toggle = (param: ScopeParam, checked: boolean) => {
    const next = new URLSearchParams(searchParams)
    if (checked) next.delete(param)
    else next.set(param, '0')
    const qs = next.toString()
    startTransition(() => router.replace(`/fitting${qs ? `?${qs}` : ''}`, { scroll: false }))
  }

  return (
    <fieldset className={styles.scopeToggles} data-pending={pending || undefined}>
      {SCOPE_TOGGLES.map(({ param, label }) => (
        <label key={param} className={styles.scopeToggle}>
          <input
            type="checkbox"
            checked={searchParams.get(param) !== '0'}
            onChange={(e) => toggle(param, e.target.checked)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  )
}
