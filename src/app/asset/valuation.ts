// Pure folds behind the /asset valuation chart (docs/asset-valuation.md): the
// stored per-owner daily values (asset_value_day) summed into one series over
// a trailing window, for the owners the page's filter keeps.
//
// An owner's row can be missing on a day it held assets: its extract failed,
// or ran late. Summing what is there would show the whole hangar dropping by
// that owner's worth for a day, so an owner's last value carries forward for
// up to CARRY_DAYS. Past that the owner counts as gone (its token lapsed, the
// character left) and adds nothing.
//
// Pure: no I/O, no Date.now(). The page feeds it rows and `now`.
import { add, ascend, descend, filter, map, mergeWith, prop, reduce, sortWith, sum, values } from 'ramda'

import { niceStep } from '../market/flow.ts'

export const CARRY_DAYS = 3
const DAY_MS = 86_400_000
// An idle hangar still has a scale of one million ISK.
const MIN_SPAN = 1_000_000

// The parts of an owner's worth, in the order the hover card lists them.
export const VALUE_PARTS = ['hangar', 'jobs', 'market', 'contracts', 'cash'] as const
export type ValuePart = (typeof VALUE_PARTS)[number]
export type ValueParts = Record<ValuePart, number>

export const PART_LABEL: Record<ValuePart, string> = {
  // Units × the day's Jita split.
  hangar: 'Hangar',
  // Manufacturing and reaction jobs not yet delivered: (1 − done) × inputs +
  // done × output, at the same price. No install fees: those are spent.
  jobs: 'Industry jobs',
  // Units left on sell orders at the split, plus the escrow held by buy orders.
  market: 'Market orders',
  // Items in our outstanding exchanges and auctions, and the collateral of
  // couriers out of our hands.
  contracts: 'Contracts',
  // Wallet balances.
  cash: 'Wallet',
}

export const zeroParts = (): ValueParts => ({ hangar: 0, jobs: 0, market: 0, contracts: 0, cash: 0 })

export const sumParts = (parts: ValueParts): number => sum(values(parts))

const addParts = (a: ValueParts, b: ValueParts): ValueParts => mergeWith(add, a, b)

export type ValueRow = {
  // A registration uuid or a corporation id, as fetchOwners() labels owners.
  ownerId: string
  // YYYY-MM-DD, UTC.
  day: string
  parts: ValueParts
  unpricedTypes: number
}

// An owner's whole worth that day: every part summed.
export type OwnerValue = { ownerId: string; value: number; carried: boolean }

export type ValuePoint = {
  day: string
  // Midnight UTC that starts the day, epoch ms.
  t: number
  // Null when no kept owner has a value that day.
  total: number | null
  // Of total, each part over the kept owners.
  parts: ValueParts
  // Largest first.
  owners: OwnerValue[]
  // Types held that day that had no price, over the kept owners.
  unpricedTypes: number
}

export const utcDayOf = (t: number): string => new Date(t).toISOString().slice(0, 10)

export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`)

// The `days` UTC days that end with today, oldest first.
export const windowDays = (now: number, days: number): string[] =>
  Array.from({ length: Math.max(1, days) }, (_, i) => utcDayOf(now - (days - 1 - i) * DAY_MS))

// owner → day → row, the lookup the carry reads.
const indexRows = (rows: readonly ValueRow[]): Map<string, Map<string, ValueRow>> =>
  reduce(
    (acc, row: ValueRow) => {
      const byDay = acc.get(row.ownerId) ?? new Map<string, ValueRow>()
      byDay.set(row.day, row)
      return acc.set(row.ownerId, byDay)
    },
    new Map<string, Map<string, ValueRow>>(),
    rows as ValueRow[]
  )

// The owner's row for a day, or the latest one within CARRY_DAYS before it.
const rowOn = (byDay: Map<string, ValueRow>, day: string): { row: ValueRow; carried: boolean } | null => {
  const back = Array.from({ length: CARRY_DAYS + 1 }, (_, i) => utcDayOf(dayStart(day) - i * DAY_MS))
  const hit = back.find((d) => byDay.has(d))
  return hit == null ? null : { row: byDay.get(hit) as ValueRow, carried: hit !== day }
}

const byValue = sortWith<OwnerValue>([descend(prop('value')), ascend(prop('ownerId'))])

// One point per day of `days`, summing the owners `keep` accepts. `rows` may
// start before the window: those days feed the carry into its first days.
export const valueSeries = (
  rows: readonly ValueRow[],
  days: readonly string[],
  keep: (ownerId: string) => boolean = () => true
): ValuePoint[] => {
  const kept = filter((r: ValueRow) => keep(r.ownerId), rows as ValueRow[])
  const index = indexRows(kept)
  // The 30-year window is mostly days before the record: those are empty
  // without a look at each owner. YYYY-MM-DD orders as a string.
  const firstDay = reduce((min: string, r: ValueRow) => (r.day < min ? r.day : min), '9999-12-31', kept)
  const empty = (day: string): ValuePoint => ({
    day,
    t: dayStart(day),
    total: null,
    parts: zeroParts(),
    owners: [],
    unpricedTypes: 0,
  })
  return map((day: string) => {
    if (day < firstDay) return empty(day)
    const hits = [...index.values()].flatMap((byDay) => {
      const hit = rowOn(byDay, day)
      return hit ? [hit] : []
    })
    const owners = byValue(
      map(({ row, carried }) => ({ ownerId: row.ownerId, value: sumParts(row.parts), carried }), hits)
    )
    return {
      day,
      t: dayStart(day),
      total: hits.length === 0 ? null : reduce((sum: number, o: OwnerValue) => sum + o.value, 0, owners),
      parts: reduce((acc: ValueParts, h) => addParts(acc, h.row.parts), zeroParts(), hits),
      owners,
      unpricedTypes: reduce((sum: number, h) => sum + h.row.unpricedTypes, 0, hits),
    }
  }, days as string[])
}

const defined = (points: readonly ValuePoint[]): ValuePoint[] =>
  filter((p: ValuePoint) => p.total != null, points as ValuePoint[])

export type ValueChange = { first: number; last: number; delta: number; pct: number | null }

// The window's first and last known totals and the change between them; null
// when the window holds no value at all.
export const windowChange = (points: readonly ValuePoint[]): ValueChange | null => {
  const known = defined(points)
  if (known.length === 0) return null
  const first = known[0].total as number
  const last = (known.at(-1) as ValuePoint).total as number
  return { first, last, delta: last - first, pct: first > 0 ? (last - first) / first : null }
}

export type ValueAxis = { lo: number; hi: number; ticks: number[] }

// The y axis: round steps around the window's lowest and highest totals,
// never below zero. Not anchored at zero, because a hangar's day-to-day moves
// are a few percent of its worth and would draw as a flat line on a scale
// that starts at nothing; the area under the line fills to the axis floor.
export const valueAxis = (points: readonly ValuePoint[], count = 4): ValueAxis => {
  const totals = map((p: ValuePoint) => p.total as number, defined(points))
  const high = totals.length ? Math.max(...totals) : 0
  const low = totals.length ? Math.min(...totals) : 0
  const spread = Math.max(high - low, MIN_SPAN, high * 0.02)
  const step = niceStep(spread / count)
  const lo = Math.max(0, Math.floor((low - step / 2) / step) * step)
  const hi = Math.max(lo + step, Math.ceil((high + step / 4) / step) * step)
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step)
  return { lo, hi, ticks }
}

// "+1.2%" / "−0.4%", or a dash when there is no base to compare against.
export const formatPct = (pct: number | null): string =>
  pct == null || !Number.isFinite(pct) ? '—' : `${pct < 0 ? '−' : '+'}${Math.abs(pct * 100).toFixed(1)}%`
