'use client'

import { useLinkStatus } from 'next/link'

import styles from './linkSpinner.module.css'

// A spinner that appears inside the link the user just clicked, for as long as
// that navigation is pending.
//
// It complements the route-level `loading.tsx` fallbacks rather than repeating
// them: the fallback answers "the app heard you" only once the new segment
// starts rendering and it replaces the whole page, so it can't say *which* of
// twenty rows is being opened. This can, and it shows up immediately at the
// click site.
//
// `useLinkStatus` reports the pending state of the nearest enclosing <Link>, so
// this must be rendered as a descendant of one — outside a link it simply never
// turns on. Server components can render it; it's a client component of its
// own, so a server-rendered table doesn't have to become one.
export const LinkSpinner = () => {
  const { pending } = useLinkStatus()
  // Nothing at all when idle: an always-present element would reserve width
  // next to every link in a table of hundreds.
  if (!pending) return null
  return <span className={styles.spinner} role="status" aria-label="Loading" />
}
