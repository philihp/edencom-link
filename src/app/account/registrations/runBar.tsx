'use client'

import { useEffect, useState } from 'react'

import { runBarFraction, runBarGap, type RunBarSide } from '../../jobs/runBar'
import styles from './registration.module.css'

// A thin bar on the top border of a "Last run" or "Next run" cell. Its length
// is the gap of time on a log scale (../../jobs/runBar.ts).
//
// "since" (last run): the bar starts at the right edge and grows to the left
// as the time since the last run increases.
// "until" (next run): the bar starts at the left edge and its right end moves
// to the left as the next run comes nearer.
//
// The clock ticks every 30 seconds, the same as NextRun, so the bar moves with
// the countdown text. The server renders with its own clock, so the first
// width can differ by a few seconds: suppressHydrationWarning accepts that.
export const RunBar = ({ at, side }: { at: string | null; side: RunBarSide }) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (at === null) return null

  const fraction = runBarFraction(runBarGap(side, new Date(at).getTime(), now))
  return (
    <span className={styles.runTrack} aria-hidden="true">
      <span
        className={styles.runBar}
        data-side={side}
        style={{ width: `${(fraction * 100).toFixed(2)}%` }}
        suppressHydrationWarning
      />
    </span>
  )
}
