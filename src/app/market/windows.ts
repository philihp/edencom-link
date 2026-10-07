// The Market page's time window: the shared trailing-days options
// (src/app/timeWindow.ts) plus what is Market's own — the bar-chart bucket
// each span implies, so the chart keeps to a readable number of bars:
//   1 day         → hourly bars (24)
//   3 days        → 6-hour bars (12)
//   7 days and up → daily bars (7 … 90)
// and the window's storage key. A single page-level control (see MarketView)
// drives every tile and the Recent Sales table off this.
import { TIME_WINDOW_OPTIONS } from '../timeWindow.ts'

export type WindowOption = {
  label: string
  days: number
  // Width of each bar-chart bucket, in hours.
  bucketHours: number
}

export const marketBucketHours = (days: number): number => (days <= 1 ? 1 : days <= 3 ? 6 : 24)

export const WINDOW_OPTIONS: WindowOption[] = TIME_WINDOW_OPTIONS.map((o) => ({
  ...o,
  bucketHours: marketBucketHours(o.days),
}))

export const DEFAULT_WINDOW_DAYS = 7
export const WINDOW_STORAGE_KEY = 'market.window.days'

// The longest span we ever need rows for: the selected window plus an equal
// preceding window (the right-most tile compares against the prior period), so
// twice the largest option.
export const MAX_WINDOW_DAYS = Math.max(...WINDOW_OPTIONS.map((o) => o.days))
export const LOOKBACK_DAYS = MAX_WINDOW_DAYS * 2

const fallback = WINDOW_OPTIONS.find((o) => o.days === DEFAULT_WINDOW_DAYS) ?? WINDOW_OPTIONS[0]

export const windowOption = (days: number): WindowOption => WINDOW_OPTIONS.find((o) => o.days === days) ?? fallback
