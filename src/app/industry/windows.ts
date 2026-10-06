// The /industry page's time window: the same trailing-days dropdown the
// Market and Structures pages carry top-right, here driving the lift chart's
// range and the job list under it. Unlike those pages nothing is refetched —
// the page already holds the whole job history — so picking a window is a
// client-side range change, and the choice persists like the Market one.
//
// Pure: no I/O, no Date.now(); the view passes its clock.

export type IndustryWindowOption = {
  label: string
  days: number
}

// Same options as the Structures page, so the three dropdowns read alike.
export const INDUSTRY_WINDOW_OPTIONS: IndustryWindowOption[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

export const DEFAULT_INDUSTRY_WINDOW_DAYS = 30
export const INDUSTRY_WINDOW_STORAGE_KEY = 'industry.window.days'

const DAY = 86_400_000
// The chart runs a little past now so the jobs still running read as the
// projection they are: up to two days, and never more than a seventh of the
// window so a one-day view is not mostly future.
const MAX_AHEAD = 2 * DAY

export const isIndustryWindowDays = (n: unknown): n is number =>
  typeof n === 'number' && INDUSTRY_WINDOW_OPTIONS.some((o) => o.days === n)

// A saved choice read back: one of the offered options, else nothing.
export const parseIndustryWindowDays = (raw: string | null | undefined): number | undefined => {
  const n = Number(raw)
  return isIndustryWindowDays(n) ? n : undefined
}

// The chart range for a window: the trailing `days` up to now, plus the
// projection ahead.
export const windowRange = (days: number, now: number): { t0: number; t1: number } => {
  const span = days * DAY
  return { t0: now - span, t1: now + Math.min(MAX_AHEAD, Math.round(span / 7)) }
}
