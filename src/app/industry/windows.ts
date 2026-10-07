// The /industry page's time window: the shared trailing-days dropdown
// (src/app/timeWindow.ts, src/app/windowSelect.tsx) the Market and Structures
// pages carry top-right, here driving the lift chart's range and the job list
// under it. Unlike those pages nothing is refetched — the page already holds
// the whole job history — so picking a window is a client-side range change,
// and the choice persists like the Market one.
//
// Pure: no I/O, no Date.now(); the view passes its clock.
import { isTimeWindowDays } from '../timeWindow.ts'

export const DEFAULT_INDUSTRY_WINDOW_DAYS = 30
export const INDUSTRY_WINDOW_STORAGE_KEY = 'industry.window.days'

const DAY = 86_400_000
// The chart runs a little past now so the jobs still running read as the
// projection they are: up to two days, and never more than a seventh of the
// window so a one-day view is not mostly future.
const MAX_AHEAD = 2 * DAY

// A saved choice read back: one of the offered options, else nothing.
export const parseIndustryWindowDays = (raw: string | null | undefined): number | undefined => {
  const n = Number(raw)
  return isTimeWindowDays(n) ? n : undefined
}

// The chart range for a window: the trailing `days` up to now, plus the
// projection ahead.
export const windowRange = (days: number, now: number): { t0: number; t1: number } => {
  const span = days * DAY
  return { t0: now - span, t1: now + Math.min(MAX_AHEAD, Math.round(span / 7)) }
}
