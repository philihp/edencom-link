// The Structures page's tax-revenue time window: the shared trailing-days
// options (src/app/timeWindow.ts, dropdown in src/app/windowSelect.tsx). A
// single control drives the revenue footer: per-structure Revenue tiles, the
// unaccounted-tax figure, and the clone revenue are all summed over the
// selected trailing window. The window lives in the URL (?days=N) so the
// server component refetches exactly the span it needs.
import { timeWindowDays } from '../timeWindow.ts'

export const DEFAULT_STRUCTURE_WINDOW_DAYS = 30

// Clamp an arbitrary ?days value to one of the offered options (defends the
// server query against hand-edited URLs), returning the default otherwise.
export const structureWindowDays = (raw: string | undefined): number =>
  timeWindowDays(raw, DEFAULT_STRUCTURE_WINDOW_DAYS)

// A sparkline is ~100px wide, so past roughly 180 points the extra readings are
// invisible — and fetching them is what made the 90-day window time out. The
// bucketed history (industry_system_index_bucket) is materialized at these three
// granularities only, so this both sizes the series and names the rows to read.
// Keep in step with the retention cuts in the materialized view: each width must
// be kept back at least as far as the widest window that selects it.
export const INDEX_BUCKET_HOURS = [1, 6, 24]

const MAX_SPARKLINE_POINTS = 180

// The coarsest-to-finest first fit: the narrowest bucket whose point count over
// `days` still fits the sparkline. 7 days → hourly (168 points), 30 days → 6h
// (120), 90 days → daily (90).
export const indexBucketHours = (days: number): number =>
  INDEX_BUCKET_HOURS.find((h) => (days * 24) / h <= MAX_SPARKLINE_POINTS) ??
  INDEX_BUCKET_HOURS[INDEX_BUCKET_HOURS.length - 1]
