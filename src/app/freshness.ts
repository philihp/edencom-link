// Freshness thresholds shared by the header indicator and the /character/refresh
// matrix: green under 15 minutes, yellow up to 6 hours, red beyond that — matching
// the extract cadence, so red means a scheduled pull was missed (or the job only
// runs daily). Kept separate from the Freshness component so server components
// can grade a timestamp without importing client code.
export const FRESH_MINUTES = 15
export const STALE_MINUTES = 360

export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'none'

export const freshnessLevel = (at: string | null | undefined, now: number = Date.now()): FreshnessLevel => {
  if (!at) return 'none'
  const minutes = (now - new Date(at).getTime()) / 60000
  if (Number.isNaN(minutes)) return 'none'
  if (minutes < FRESH_MINUTES) return 'fresh'
  if (minutes < STALE_MINUTES) return 'aging'
  return 'stale'
}

// "5 minutes ago" — coarse on purpose: the freshness dot carries the signal,
// the text just gives it a scale.
export const relativeTime = (at: string, now: number): string => {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
