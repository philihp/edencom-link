import { addIndex, ascend, descend, drop, filter, map, prop, reduce, sortWith, sum, take } from 'ramda'
import { match } from 'ts-pattern'

// The pure geometry under the donut chart (donut.tsx). It turns a list of
// values into ring slices: it keeps the largest slices, puts the rest into one
// "other" slice, gives each slice its start and end angle, makes the SVG path
// of each annular sector, and finds the point for each label.
//
// Angles are in radians. Angle 0 is at the top of the ring (12 o'clock) and
// the angle increases clockwise, so the largest slice starts at the top.
// All coordinates are rounded to 3 decimals, so that the same input always
// gives the same path text.

export type Datum = {
  key: string
  label: string
  value: number
}

export type Slice = Datum & {
  // The part of the total, from 0 to 1.
  share: number
  start: number
  end: number
  // True only for the slice that holds the rest.
  other: boolean
  // How many data the slice holds: 1, or more for "other".
  count: number
}

export type Ring = {
  cx: number
  cy: number
  // The outer radius and the inner radius. An inner radius of 0 gives a pie.
  r: number
  inner: number
}

export type Point = { x: number; y: number }

export const OTHER_KEY = '__other__'
export const OTHER_LABEL = 'other'

const TAU = 2 * Math.PI

const round = (n: number): number => Math.round(n * 1000) / 1000 || 0

// Only a finite value above zero can have an area on the ring.
const usable = (d: Datum): boolean => Number.isFinite(d.value) && d.value > 0

// Largest first. Equal values sort by key, so the order is always the same.
const byValue = sortWith<Datum>([descend(prop('value')), ascend(prop('key'))])

// Keep the `limit` largest data and put the rest into one "other" datum. When
// only one datum is left over, it keeps its own name: an "other" of one item
// hides a name and gives no space back.
export const topN =
  (limit: number) =>
  (data: readonly Datum[]): (Datum & { other: boolean; count: number })[] => {
    const sorted = byValue(filter(usable, data))
    const head = sorted.length <= limit + 1 ? sorted : take(limit, sorted)
    const rest = sorted.length <= limit + 1 ? [] : drop(limit, sorted)
    const kept = map((d: Datum) => ({ ...d, other: false, count: 1 }), head)
    return rest.length === 0
      ? kept
      : [
          ...kept,
          {
            key: OTHER_KEY,
            label: OTHER_LABEL,
            value: sum(map(prop('value'), rest)),
            other: true,
            count: rest.length,
          },
        ]
  }

export const total = (data: readonly Pick<Datum, 'value'>[]): number => sum(map(prop('value'), data))

// Give each datum its share of the total and its angles. The data must already
// be in drawing order (topN gives that order).
export const toSlices = (data: readonly (Datum & { other: boolean; count: number })[]): Slice[] => {
  const whole = total(data)
  if (whole <= 0) return []
  const step = reduce(
    (acc: { at: number; out: Slice[] }, d: Datum & { other: boolean; count: number }) => {
      const share = d.value / whole
      const end = acc.at + share * TAU
      acc.out.push({ ...d, share, start: acc.at, end })
      return { at: end, out: acc.out }
    },
    { at: 0, out: [] },
    data
  )
  return step.out
}

// Slices from raw values in one step: the top `limit` plus "other".
export const slicesOf =
  (limit: number) =>
  (data: readonly Datum[]): Slice[] =>
    toSlices(topN(limit)(data))

export const polar = (cx: number, cy: number, radius: number, angle: number): Point => ({
  x: round(cx + radius * Math.sin(angle)),
  y: round(cy - radius * Math.cos(angle)),
})

const pt = ({ x, y }: Point): string => `${x} ${y}`

// The SVG path of one annular sector from `start` to `end`. SVG cannot draw an
// arc whose two ends are the same point, so a slice of the full ring is two
// half arcs on each edge.
export const arcPath = ({ cx, cy, r, inner }: Ring, start: number, end: number): string => {
  const span = end - start
  if (span <= 0) return ''
  if (span >= TAU - 1e-9) {
    const outer = `M ${pt(polar(cx, cy, r, 0))} A ${r} ${r} 0 1 1 ${pt(polar(cx, cy, r, Math.PI))} A ${r} ${r} 0 1 1 ${pt(polar(cx, cy, r, 0))} Z`
    return inner <= 0
      ? outer
      : `${outer} M ${pt(polar(cx, cy, inner, 0))} A ${inner} ${inner} 0 1 0 ${pt(polar(cx, cy, inner, Math.PI))} A ${inner} ${inner} 0 1 0 ${pt(polar(cx, cy, inner, 0))} Z`
  }
  const large = span > Math.PI ? 1 : 0
  const o0 = polar(cx, cy, r, start)
  const o1 = polar(cx, cy, r, end)
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${pt(o0)} A ${r} ${r} 0 ${large} 1 ${pt(o1)} Z`
  }
  const i1 = polar(cx, cy, inner, end)
  const i0 = polar(cx, cy, inner, start)
  return `M ${pt(o0)} A ${r} ${r} 0 ${large} 1 ${pt(o1)} L ${pt(i1)} A ${inner} ${inner} 0 ${large} 0 ${pt(i0)} Z`
}

export const midAngle = (slice: Pick<Slice, 'start' | 'end'>): number => (slice.start + slice.end) / 2

// The point for a slice's label: on the middle of the band, at the slice's
// middle angle. A slice narrower than `minShare` of the ring gets no label
// (null), because its label would not fit; the legend still names it.
export const labelPoint =
  (ring: Ring, minShare = 0.06) =>
  (slice: Pick<Slice, 'start' | 'end' | 'share'>): Point | null =>
    slice.share < minShare ? null : polar(ring.cx, ring.cy, (ring.r + ring.inner) / 2, midAngle(slice))

// The fill of each slice: the accent for the largest, then a ramp of grays
// that become lighter against the canvas, and the faintest gray for "other".
// The grays mix the ink token into the paper token, so the ramp works in the
// light theme and in the dark theme. Status colours are never used here.
const GRAY_STEPS = [62, 46, 34, 25, 18, 13, 9] as const
const gray = (percent: number): string => `color-mix(in srgb, var(--ink) ${percent}%, var(--paper))`
export const OTHER_FILL = 'var(--line)'

export const fillOf = (slice: Pick<Slice, 'other'>, index: number): string =>
  slice.other
    ? OTHER_FILL
    : index === 0
      ? 'var(--accent)'
      : gray(GRAY_STEPS[Math.min(index - 1, GRAY_STEPS.length - 1)])

export const fills = (slices: readonly Slice[]): string[] => addIndex<Slice, string>(map)(fillOf, slices)

// Text for a share, e.g. "42%", or "<1%" for a slice too small to round up.
export const formatShare = (share: number): string =>
  share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`

export type Unit = 'isk' | 'count'

// Short text for a value: ISK as "1.23B" / "4.5M" / "678k", a count with
// thousands separators.
export const formatValue = (unit: Unit, value: number): string =>
  !Number.isFinite(value)
    ? '—'
    : match(unit)
        .with('count', () => Math.round(value).toLocaleString('en-US'))
        .with('isk', () => compactIsk(value))
        .exhaustive()

const compactIsk = (value: number): string => {
  const v = Math.abs(value)
  const sign = value < 0 ? '−' : ''
  return v >= 1e9
    ? `${sign}${(v / 1e9).toFixed(2)}B`
    : v >= 1e6
      ? `${sign}${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
        ? `${sign}${(v / 1e3).toFixed(0)}k`
        : `${sign}${Math.round(v)}`
}
