import { ascend, descend, filter, map, prop, propEq, reduce, sortWith, take } from 'ramda'

import type { Side, Trade } from './trade'

// Pure folds over the page's trades. "Total" everywhere on this page means
// summed ISK turnover (unit price × quantity), not transaction count or unit
// quantity. Every window is half-open: [start, end).

export const tradeValue = (t: Trade): number => t.unit_price * t.quantity
const tradeTime = (t: Trade): number => Date.parse(t.date)

export const inWindow =
  (start: number, end: number) =>
  (t: Trade): boolean =>
    tradeTime(t) >= start && tradeTime(t) < end

export const onSide = (side: Side) => filter<Trade>(propEq(side, 'side'))

export type Totals = { total: number; quantity: number; count: number }

const ZERO: Totals = { total: 0, quantity: 0, count: 0 }

const addTrade = (cur: Totals, t: Trade): Totals => ({
  total: cur.total + tradeValue(t),
  quantity: cur.quantity + t.quantity,
  count: cur.count + 1,
})

// The sum of all trades in the list.
export const totalsOf = (trades: Trade[]): Totals => reduce(addTrade, ZERO, trades)

// Totals per key. The Map is the accumulator, so the fold stays O(n).
export const totalsBy =
  (keyOf: (t: Trade) => number) =>
  (trades: Trade[]): Map<number, Totals> =>
    reduce(
      (acc: Map<number, Totals>, t: Trade) => acc.set(keyOf(t), addTrade(acc.get(keyOf(t)) ?? ZERO, t)),
      new Map<number, Totals>(),
      trades
    )

// Largest total first. Equal totals sort by the smaller key first, so the order
// does not change with the order of the input.
const rankTotals = <K extends string>(key: K, limit: number, totals: Map<number, Totals>) =>
  take(
    limit,
    sortWith<Record<K, number> & Totals>(
      [descend(prop('total')), ascend((r) => r[key])],
      map(([id, t]) => ({ [key]: id, ...t }) as Record<K, number> & Totals, [...totals.entries()])
    )
  )

export type TypeTotal = Totals & { typeId: number }
export type CounterpartyTotal = Totals & { clientId: number }

// Top-N type_ids by summed ISK value of the trades in [start, end).
export const topTypesByValue = (trades: Trade[], start: number, end: number, limit: number): TypeTotal[] =>
  rankTotals('typeId', limit, totalsBy(prop('type_id'))(filter(inWindow(start, end), trades)))

// Top-N counterparties (client_id) by summed ISK value of the trades in [start, end).
export const topCounterpartiesByValue = (
  trades: Trade[],
  start: number,
  end: number,
  limit: number
): CounterpartyTotal[] =>
  rankTotals('clientId', limit, totalsBy(prop('client_id'))(filter(inWindow(start, end), trades)))

export type Bucket = { start: number; end: number; total: number }

// Bucketed ISK totals across [start, end) in fixed-width slices. The window
// always divides evenly by the bucket width (see WINDOW_OPTIONS), so the
// right-most bucket ends exactly at `end` (= now).
export const bucketTrades = (trades: Trade[], start: number, end: number, bucketMs: number): Bucket[] => {
  const count = Math.max(1, Math.round((end - start) / bucketMs))
  const indexOf = (t: Trade) => Math.min(count - 1, Math.floor((tradeTime(t) - start) / bucketMs))
  const sums = reduce(
    (acc: number[], t: Trade) => {
      acc[indexOf(t)] += tradeValue(t)
      return acc
    },
    Array.from({ length: count }, () => 0),
    filter(inWindow(start, end), trades)
  )
  return sums.map((total, i) => ({ start: start + i * bucketMs, end: start + (i + 1) * bucketMs, total }))
}
