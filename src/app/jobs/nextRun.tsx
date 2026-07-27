'use client'

import { useEffect, useState } from 'react'

import styles from './jobs.module.css'

// Countdown to a job's next scheduled fire. The server passes the absolute
// instant (computed from vercel.json's cron in UTC — see ./schedule.ts) and this
// only formats the gap, so ticking the clock never re-renders the server
// component the way the refresh poller does. Title carries the exact UTC time,
// since that's the only timezone the schedule is expressed in.
export const NextRun = ({ at }: { at: string | null }) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (at === null) {
    return (
      <span className={styles.manual} title="No vercel.json cron entry — runs only when kicked by hand">
        manual only
      </span>
    )
  }

  const minutes = Math.max(0, Math.round((new Date(at).getTime() - now) / 60_000))
  const hours = Math.floor(minutes / 60)
  const text = hours > 0 ? `in ${hours}h ${minutes % 60}m` : minutes > 0 ? `in ${minutes}m` : 'due now'

  return (
    <span className={styles.nextRun} title={`${at.replace('T', ' ').slice(0, 16)} UTC`} suppressHydrationWarning>
      {text}
    </span>
  )
}
