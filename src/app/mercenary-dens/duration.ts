// Tiered duration formatting for the mercenary-dens page. The unit widens with
// the horizon so the number stays readable at a glance:
//   under 15 minutes        → "12m 34s"  (minutes and seconds)
//   15–90 minutes           → "47m"      (minutes)
//   over 90 minutes         → "26h"      (hours)
//   over 36 hours           → "3d"       (days)
//   over 7 days             → "2w 3d"    (weeks and days)
// Used for both "time until" (reinforcement end) and "time since" (status
// observed) — the caller supplies a non-negative millisecond span.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export const formatDuration = (ms: number): string => {
  const t = Math.max(0, ms)
  if (t > 7 * DAY) {
    const weeks = Math.floor(t / WEEK)
    const days = Math.round((t - weeks * WEEK) / DAY)
    // Rounding the remainder up to a full week rolls over into the next one.
    return days === 7 ? `${weeks + 1}w 0d` : `${weeks}w ${days}d`
  }
  if (t > 36 * HOUR) return `${Math.round(t / DAY)}d`
  if (t > 90 * MINUTE) return `${Math.round(t / HOUR)}h`
  if (t < 15 * MINUTE) return `${Math.floor(t / MINUTE)}m ${Math.floor((t % MINUTE) / SECOND)}s`
  return `${Math.round(t / MINUTE)}m`
}

// "2026-07-15 14:32:07 UTC" — EVE time is UTC, so render the wall-clock stamp
// directly rather than localizing it. Seconds included: mercenary-den timers
// are second-precise and the reinforcement time is now entered to the second.
export const formatUtc = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}
