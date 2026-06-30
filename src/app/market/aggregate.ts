import type { Sale } from './recentSales'

// Sale value in raw ISK. "Total sales" everywhere on this page means summed ISK
// turnover (unit price × quantity), not transaction count or unit quantity.
const value = (s: Sale) => Number(s.unit_price) * Number(s.quantity)

export type TypeTotal = { typeId: number; total: number; quantity: number }

// Top-N type_ids by summed ISK value of sales whose date falls in [start, end).
// Also carries the summed unit quantity sold in the same window.
export const topTypesByValue = (sales: Sale[], start: number, end: number, limit: number): TypeTotal[] => {
  const agg = sales
    .filter((s) => {
      const t = Date.parse(s.date)
      return t >= start && t < end
    })
    .reduce((agg, s) => {
      const typeId = Number(s.type_id)
      const cur = agg.get(typeId) ?? { total: 0, quantity: 0 }
      agg.set(typeId, { total: cur.total + value(s), quantity: cur.quantity + Number(s.quantity) })
      return agg
    }, new Map<number, { total: number; quantity: number }>())
  return [...agg.entries()]
    .map(([typeId, { total, quantity }]) => ({ typeId, total, quantity }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
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
  return sales.reduce((buckets, s) => {
    const t = Date.parse(s.date)
    if (t < start || t >= end) return buckets
    const idx = Math.min(count - 1, Math.floor((t - start) / bucketMs))
    buckets[idx].total += value(s)
    return buckets
  }, buckets)
}
