import { find, last, map, reduce, scan, tail, zipWith } from 'ramda'

import { formatTick } from '../industry/chartTime.ts'
import { bucketTrades, onSide, type Bucket } from './aggregate.ts'
import type { Trade } from './trade.ts'

// Pure folds behind the market flow chart: sales and purchases per bucket as
// two series, and the net ISK flow (sales minus purchases) summed over the
// window. The bucket rule stays in windows.ts and the bucketing in
// aggregate.ts; this file only puts the two sides side by side.

export type FlowBucket = {
  start: number
  end: number
  // ISK we got from sales in this bucket.
  sales: number
  // ISK we paid for purchases in this bucket.
  purchases: number
  // sales − purchases in this bucket.
  net: number
  // The sum of `net` from the start of the window to the end of this bucket.
  cumulative: number
}

const pairBuckets = (sells: Bucket[], buys: Bucket[]) =>
  zipWith(
    (s: Bucket, b: Bucket) => ({
      start: s.start,
      end: s.end,
      sales: s.total,
      purchases: b.total,
      net: s.total - b.total,
    }),
    sells,
    buys
  )

// The running sum of `net`. scan gives the seed (0) first, so tail removes it.
const withCumulative = (rows: Omit<FlowBucket, 'cumulative'>[]): FlowBucket[] =>
  zipWith(
    (r, cumulative: number) => ({ ...r, cumulative }),
    rows,
    tail(scan((acc: number, r: { net: number }) => acc + r.net, 0, rows))
  )

// Both sides of the trades in [start, end), in buckets of `bucketMs`. The two
// series always have the same buckets, because bucketTrades makes the same
// slices for the same window.
export const flowBuckets = (trades: Trade[], start: number, end: number, bucketMs: number): FlowBucket[] =>
  withCumulative(
    pairBuckets(
      bucketTrades(onSide('sell')(trades), start, end, bucketMs),
      bucketTrades(onSide('buy')(trades), start, end, bucketMs)
    )
  )

// The net flow over the whole window: the cumulative value of the last bucket.
export const netOf = (rows: FlowBucket[]): number => last(rows)?.cumulative ?? 0

// The smallest 1, 2 or 5 × 10^k at or above x. Zero or less gives 1.
export const niceStep = (x: number): number => {
  if (!(x > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(x))
  return (find((step) => step * magnitude >= x, [1, 2, 5, 10]) ?? 10) * magnitude
}

export type Axis = { lo: number; hi: number; step: number; ticks: number[] }

// An idle window still has a scale of one million ISK.
const MIN_SPAN = 1_000_000

// The y axis of the flow chart. Sales bars go up from zero, purchases bars go
// down from zero, and the net line can be on either side, so the axis always
// holds zero, the tallest sales bar, the deepest purchases bar, and the
// highest and lowest net. The bounds are whole steps, and the step is a round
// number, so about `count` ticks fit between them.
export const flowAxis = (rows: FlowBucket[], count = 4): Axis => {
  const high = reduce((m: number, r: FlowBucket) => Math.max(m, r.sales, r.cumulative), 0, rows)
  const low = reduce((m: number, r: FlowBucket) => Math.min(m, -r.purchases, r.cumulative), 0, rows)
  const top = Math.max(high, low + MIN_SPAN)
  const step = niceStep((top - low) / count)
  const lo = Math.floor(low / step) * step
  const hi = Math.ceil(top / step) * step
  const ticks = map(
    (i: number) => lo + i * step,
    Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => i)
  )
  // -0 shows as "−0" in some formatters; make it a plain zero.
  return { lo: lo || 0, hi, step, ticks: map((t: number) => t || 0, ticks) }
}

// The indexes of the bucket edges that get an x label: about `max` of them,
// evenly spaced, the first edge (the window start) always one of them. Edge i
// is the start of bucket i; edge n is the end of the window.
export const xTickEdges = (n: number, max: number): number[] => {
  const every = Math.max(1, Math.ceil(n / Math.max(1, max)))
  return Array.from({ length: Math.floor(n / every) + 1 }, (_, i) => i * every)
}

const pad = (n: number) => String(n).padStart(2, '0')
const hourOf = (t: number) => `${pad(new Date(t).getUTCHours())}:${pad(new Date(t).getUTCMinutes())}`

// An x-axis label, in UTC so the server and the client agree. Hourly buckets
// (the 1-day window) show the hour; wider buckets show the day.
export const flowTick = (t: number, bucketHours: number): string =>
  bucketHours < 6 ? hourOf(t) : bucketHours < 24 ? `${formatTick(t, false)} ${hourOf(t)}` : formatTick(t, false)

// The time of one bucket, as the hover card says it, in UTC:
// "4 Nov 2026" for a daily bucket, "4 Nov 2026 06:00–12:00" for a shorter one.
export const flowMoment = (b: Pick<FlowBucket, 'start' | 'end'>, bucketHours: number): string => {
  const day = `${formatTick(b.start, false)} ${new Date(b.start).getUTCFullYear()}`
  return bucketHours < 24 ? `${day} ${hourOf(b.start)}–${hourOf(b.end)}` : day
}
