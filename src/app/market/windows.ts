// The Market page's time window. A single page-level control (see MarketView)
// drives every tile and the Recent Sales table off this. The chosen window also
// dictates the bar-chart bucket granularity:
//   1 day        → hourly bars (24)
//   3 days       → 6-hour bars (12)
//   7/30/90 days → daily bars (7/30/90)
export type WindowOption = {
  label: string
  days: number
  // Width of each bar-chart bucket, in hours.
  bucketHours: number
}

export const WINDOW_OPTIONS: WindowOption[] = [
  { label: '1 day', days: 1, bucketHours: 1 },
  { label: '3 days', days: 3, bucketHours: 6 },
  { label: '7 days', days: 7, bucketHours: 24 },
  { label: '30 days', days: 30, bucketHours: 24 },
  { label: '90 days', days: 90, bucketHours: 24 },
]

export const DEFAULT_WINDOW_DAYS = 7
export const WINDOW_STORAGE_KEY = 'market.window.days'

// The longest span we ever need rows for: the selected window plus an equal
// preceding window (the right-most tile compares against the prior period), so
// twice the largest option.
export const MAX_WINDOW_DAYS = Math.max(...WINDOW_OPTIONS.map((o) => o.days))
export const LOOKBACK_DAYS = MAX_WINDOW_DAYS * 2

const fallback = WINDOW_OPTIONS.find((o) => o.days === DEFAULT_WINDOW_DAYS) ?? WINDOW_OPTIONS[0]

export const windowOption = (days: number): WindowOption =>
  WINDOW_OPTIONS.find((o) => o.days === days) ?? fallback
