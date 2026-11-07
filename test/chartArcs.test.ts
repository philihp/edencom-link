// Unit coverage for src/app/charts/arcs.ts, the geometry under the donut
// chart: which slices it keeps, their angles, the SVG paths, the label points
// and the fills.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arcPath,
  fillOf,
  formatShare,
  formatValue,
  labelPoint,
  OTHER_FILL,
  OTHER_KEY,
  polar,
  slicesOf,
  topN,
  toSlices,
  total,
} from '../src/app/charts/arcs.ts'

const d = (key: string, value: number) => ({ key, label: key, value })
const RING = { cx: 100, cy: 100, r: 50, inner: 30 }
const TAU = 2 * Math.PI

test('topN sorts largest first and breaks ties by key', () => {
  const out = topN(5)([d('b', 1), d('a', 1), d('c', 3)])
  assert.deepEqual(
    out.map((s) => s.key),
    ['c', 'a', 'b']
  )
  assert.ok(out.every((s) => !s.other && s.count === 1))
})

test('topN puts the rest into one "other" slice', () => {
  const out = topN(2)([d('a', 5), d('b', 4), d('c', 3), d('e', 2), d('f', 1)])
  assert.deepEqual(
    out.map((s) => s.key),
    ['a', 'b', OTHER_KEY]
  )
  const other = out[2]
  assert.equal(other.value, 6)
  assert.equal(other.count, 3)
  assert.equal(other.other, true)
  assert.equal(other.label, 'other')
})

test('topN keeps a single leftover under its own name', () => {
  const out = topN(2)([d('a', 3), d('b', 2), d('c', 1)])
  assert.deepEqual(
    out.map((s) => s.key),
    ['a', 'b', 'c']
  )
})

test('topN drops zero, negative and non-finite values', () => {
  const out = topN(8)([d('a', 0), d('b', -2), d('c', Number.NaN), d('e', Infinity), d('f', 1)])
  assert.deepEqual(
    out.map((s) => s.key),
    ['f']
  )
})

test('toSlices gives shares that add to one and angles that close the ring', () => {
  const slices = toSlices(topN(8)([d('a', 3), d('b', 1)]))
  assert.equal(slices[0].share, 0.75)
  assert.equal(slices[1].share, 0.25)
  assert.equal(slices[0].start, 0)
  assert.equal(slices[0].end, slices[1].start)
  assert.ok(Math.abs(slices[1].end - TAU) < 1e-12)
  assert.equal(total(slices), 4)
})

test('toSlices and slicesOf give nothing for no usable data', () => {
  assert.deepEqual(toSlices([]), [])
  assert.deepEqual(slicesOf(8)([d('a', 0)]), [])
})

test('polar puts angle 0 at the top and turns clockwise', () => {
  assert.deepEqual(polar(100, 100, 50, 0), { x: 100, y: 50 })
  assert.deepEqual(polar(100, 100, 50, Math.PI / 2), { x: 150, y: 100 })
  assert.deepEqual(polar(100, 100, 50, Math.PI), { x: 100, y: 150 })
})

test('arcPath draws an annular sector for a quarter', () => {
  assert.equal(arcPath(RING, 0, Math.PI / 2), 'M 100 50 A 50 50 0 0 1 150 100 L 130 100 A 30 30 0 0 0 100 70 Z')
})

test('arcPath sets the large-arc flag past a half', () => {
  assert.match(arcPath(RING, 0, 1.5 * Math.PI), /A 50 50 0 1 1/)
})

test('arcPath draws a pie wedge when the inner radius is 0', () => {
  assert.equal(arcPath({ ...RING, inner: 0 }, 0, Math.PI / 2), 'M 100 100 L 100 50 A 50 50 0 0 1 150 100 Z')
})

test('arcPath draws the full ring as two half arcs on each edge', () => {
  assert.equal(
    arcPath(RING, 0, TAU),
    'M 100 50 A 50 50 0 1 1 100 150 A 50 50 0 1 1 100 50 Z M 100 70 A 30 30 0 1 0 100 130 A 30 30 0 1 0 100 70 Z'
  )
})

test('arcPath gives no path for an empty slice', () => {
  assert.equal(arcPath(RING, 1, 1), '')
})

test('labelPoint is on the middle of the band at the middle angle', () => {
  assert.deepEqual(labelPoint(RING)({ start: 0, end: Math.PI, share: 0.5 }), { x: 140, y: 100 })
})

test('labelPoint gives no point for a thin slice', () => {
  assert.equal(labelPoint(RING)({ start: 0, end: 0.1, share: 0.02 }), null)
})

test('fillOf: accent first, grays after, the line gray for other', () => {
  assert.equal(fillOf({ other: false }, 0), 'var(--accent)')
  assert.match(fillOf({ other: false }, 1), /^color-mix\(in srgb, var\(--ink\) \d+%, var\(--paper\)\)$/)
  assert.notEqual(fillOf({ other: false }, 1), fillOf({ other: false }, 2))
  assert.equal(fillOf({ other: false }, 40), fillOf({ other: false }, 41))
  assert.equal(fillOf({ other: true }, 3), OTHER_FILL)
})

test('formatShare rounds to whole percent and marks a sliver', () => {
  assert.equal(formatShare(0.4249), '42%')
  assert.equal(formatShare(0.001), '<1%')
  assert.equal(formatShare(0), '0%')
})

test('formatValue writes ISK short and counts in full', () => {
  assert.equal(formatValue('isk', 1_234_000_000), '1.23B')
  assert.equal(formatValue('isk', 4_560_000), '4.6M')
  assert.equal(formatValue('isk', 678_000), '678k')
  assert.equal(formatValue('isk', 12), '12')
  assert.equal(formatValue('count', 12345), '12,345')
  assert.equal(formatValue('isk', Number.NaN), '—')
})
