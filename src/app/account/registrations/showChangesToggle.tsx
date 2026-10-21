'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { SHOW_CHANGES_COOKIE, SHOW_CHANGES_MAX_AGE } from './registrationsShowChanges'

// Writes the cookie client-side and re-renders the server component, which
// reads it to pick the matrix columns.
export const ShowChangesToggle = ({ on }: { on: boolean }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const toggle = () => {
    document.cookie = `${SHOW_CHANGES_COOKIE}=${on ? '0' : '1'}; Path=/; Max-Age=${SHOW_CHANGES_MAX_AGE}; SameSite=Lax`
    startTransition(() => router.refresh())
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      data-pending={pending || undefined}
      onClick={toggle}
      title="These grants let this site change something in game — save or delete fittings, send mail — rather than only read it"
    >
      {on ? 'Hide grants that change things' : 'Show grants that change things'}
    </button>
  )
}
