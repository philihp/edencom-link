// The Indexes page's time window, mirroring the Market page's dropdown. The
// chosen window also dictates the sparkline bucket width so long windows keep
// to a sane number of points: hourly up to a week (the pull job runs hourly),
// then 6-hour buckets at 30 days and daily buckets at 90.
export type IndexWindowOption = {
  label: string
  days: number
  // Width of each averaged sparkline bucket, in hours.
  bucketHours: number
}

export const INDEX_WINDOW_OPTIONS: IndexWindowOption[] = [
  { label: '1 day', days: 1, bucketHours: 1 },
  { label: '3 days', days: 3, bucketHours: 1 },
  { label: '7 days', days: 7, bucketHours: 1 },
  { label: '30 days', days: 30, bucketHours: 6 },
  { label: '90 days', days: 90, bucketHours: 24 },
]

export const DEFAULT_INDEX_WINDOW_DAYS = 7

const fallback = INDEX_WINDOW_OPTIONS.find((o) => o.days === DEFAULT_INDEX_WINDOW_DAYS) ?? INDEX_WINDOW_OPTIONS[0]

export const indexWindowOption = (days: number): IndexWindowOption =>
  INDEX_WINDOW_OPTIONS.find((o) => o.days === days) ?? fallback
