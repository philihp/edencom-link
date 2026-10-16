'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { PRODUCTION_ONLY_COOKIE, PRODUCTION_ONLY_MAX_AGE } from './productionOnly'
import styles from './indexes.module.css'

// Writes the cookie client-side and re-renders the server component, which
// reads it to pick the columns.
export const ProductionOnlyToggle = ({ on }: { on: boolean }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const toggle = () => {
    document.cookie = `${PRODUCTION_ONLY_COOKIE}=${on ? '0' : '1'}; Path=/; Max-Age=${PRODUCTION_ONLY_MAX_AGE}; SameSite=Lax`
    startTransition(() => router.refresh())
  }
  return (
    <button
      type="button"
      className={styles.productionOnly}
      aria-pressed={on}
      data-pending={pending || undefined}
      onClick={toggle}
      title="Hide research, copying and invention"
    >
      Manufacturing &amp; reactions only
    </button>
  )
}
