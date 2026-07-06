'use client'

import { useEffect, useState } from 'react'

import { freshnessLevel, relativeTime } from './freshness'
import styles from './freshness.module.css'

type FreshnessProps = {
  at: string | null | undefined
  // Prepended to the relative time, e.g. prefix="Refreshed" → "Refreshed 5 minutes ago".
  prefix?: string
  // Shown (alone, without the prefix) when there's no timestamp at all.
  never?: string
}

// Colored freshness dot plus a live relative timestamp, re-evaluated every half
// minute so the color and text roll over without a reload. The initial client
// render can disagree with the server's by a minute, hence the hydration
// suppression on the time text.
export const Freshness = ({ at, prefix, never = 'never' }: FreshnessProps) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const level = freshnessLevel(at, now)
  const text = at ? [prefix, relativeTime(at, now)].filter(Boolean).join(' ') : never
  return (
    <span className={styles.freshness} data-level={level} suppressHydrationWarning>
      <span className={styles.dot} aria-hidden="true" /> <span suppressHydrationWarning>{text}</span>
    </span>
  )
}
