import { filter, map, reduce, sortBy } from 'ramda'
import type { Sale } from './recentSales'

// Sale value in raw ISK. "Total sales" everywhere on this page means summed ISK
// turnover (unit price × quantity), not transaction count or unit quantity.
const value = (s: Sale) => Number(s.unit_price) * Number(s.quantity)
const saleTime = (s: Sale) => Date.parse(s.date)
const inWindow = (start: number, end: number) => (s: Sale) => saleTime(s) >= start && saleTime(s) < end

export type TypeTotal = { typeId: number; total: number; quantity: number }

// Top-N type_ids by summed ISK value of sales whose date falls in [start, end).
// Also carries the summed unit quantity sold in the same window.
export const topTypesByValue = (sales: Sale[], start: number, end: number, limit: number): TypeTotal[] => {
  const agg = reduce(
    (agg: Map<number, { total: number; quantity: number }>, s: Sale) => {
      const typeId = Number(s.type_id)
      const cur = agg.get(typeId) ?? { total: 0, quantity: 0 }
      agg.set(typeId, { total: cur.total + value(s), quantity: cur.quantity + Number(s.quantity) })
      return agg
    },
    new Map<number, { total: number; quantity: number }>(),
    filter(inWindow(start, end), sales)
  )
  const totals: TypeTotal[] = map(([typeId, { total, quantity }]) => ({ typeId, total, quantity }), [...agg.entries()])
  return sortBy((t) => -t.total, totals).slice(0, limit)
}

export type Bucket = { start: number; end: number; total: number }

// Bucketed ISK totals across [start, end) in fixed-width slices. The window
// always divides evenly by the bucket width (see WINDOW_OPTIONS), so the
// right-most bucket ends exactly at `end` (= now).
export const bucketSales = (sales: Sale[], start: number, end: number, bucketMs: number): Bucket[] => {
  const count = Math.max(1, Math.round((end - start) / bucketMs))
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    start: start + i * bucketMs,
    end: start + (i + 1) * bucketMs,
    total: 0,
  }))
  return reduce(
    (buckets: Bucket[], s: Sale) => {
      const idx = Math.min(count - 1, Math.floor((saleTime(s) - start) / bucketMs))
      buckets[idx].total += value(s)
      return buckets
    },
    buckets,
    filter(inWindow(start, end), sales)
  )
}
