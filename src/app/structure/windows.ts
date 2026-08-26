// The Structures page's tax-revenue time window, mirroring the Market/Indexes
// page dropdowns. A single control (see WindowSelect) drives the revenue
// footer: per-structure Revenue tiles, the unaccounted-tax figure, and the
// clone revenue are all summed over the selected trailing window. The window
// lives in the URL (?days=N) so the server component refetches exactly the span
// it needs.
export type StructureWindowOption = {
  label: string
  days: number
}

export const STRUCTURE_WINDOW_OPTIONS: StructureWindowOption[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

export const DEFAULT_STRUCTURE_WINDOW_DAYS = 30

const fallback =
  STRUCTURE_WINDOW_OPTIONS.find((o) => o.days === DEFAULT_STRUCTURE_WINDOW_DAYS) ?? STRUCTURE_WINDOW_OPTIONS[0]

// Clamp an arbitrary ?days value to one of the offered options (defends the
// server query against hand-edited URLs), returning the default otherwise.
export const structureWindowDays = (raw: string | undefined): number => {
  const n = Number(raw)
  return STRUCTURE_WINDOW_OPTIONS.some((o) => o.days === n) ? n : fallback.days
}

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
