'use client'

import { useEffect, useState } from 'react'

import { formatDuration } from './duration'

// Live "time remaining" for a reinforcement timer. The first render uses the
// server-supplied `now` (a plain serialized number, identical on the server and
// on hydration, so no mismatch), then a 1s interval takes over and the value
// ticks down in the browser without a round trip. formatDuration clamps at 0,
// so a lapsed timer settles on "0m 0s" until the next page load re-evaluates it
// as expired.
export const Countdown = ({ end, now }: { end: string; now: number }) => {
  const endMs = new Date(end).getTime()
  const [current, setCurrent] = useState(now)

  useEffect(() => {
    const tick = () => setCurrent(Date.now())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return <>{formatDuration(endMs - current)}</>
}
