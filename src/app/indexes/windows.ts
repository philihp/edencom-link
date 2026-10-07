// The Indexes page's time window: the shared trailing-days options
// (src/app/timeWindow.ts) plus what is Indexes' own — the sparkline bucket
// width each span implies, so long windows keep to a sane number of points:
// hourly up to a week (the pull job runs hourly), 6-hour buckets to a month,
// daily past that. The widths are the three the bucketed history view is
// materialised at (INDEX_BUCKET_HOURS in ../structure/windows.ts).
import { timeWindowDays } from '../timeWindow.ts'

export type IndexWindowOption = {
  days: number
  // Width of each averaged sparkline bucket, in hours.
  bucketHours: number
}

export const DEFAULT_INDEX_WINDOW_DAYS = 7

export const indexBucketHours = (days: number): number => (days <= 7 ? 1 : days <= 30 ? 6 : 24)

// The `?days=` param clamped to an offered span, with the bucket it implies.
export const indexWindowOption = (raw: unknown): IndexWindowOption => {
  const days = timeWindowDays(raw, DEFAULT_INDEX_WINDOW_DAYS)
  return { days, bucketHours: indexBucketHours(days) }
}
