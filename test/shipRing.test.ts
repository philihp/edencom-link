// The fitting ring's geometry: which slot lands where. Positions come back as
// fractions of the ring's square rather than pixels, so what's worth pinning is
// the arrangement — each family in its own quadrant of a band, spread inside it
// by pointille — and that it holds for hulls whose slot counts are nothing like
// a battleship's.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ringCells } from '../src/app/ship/[itemId]/ring.ts'
import type { SlotCounts } from '../src/app/ship/[itemId]/esf/attributes.ts'

const counts = (over: Partial<SlotCounts> = {}): SlotCounts => ({
  High: 0,
  Medium: 0,
  Low: 0,
  SubSystem: 0,
  Rig: 0,
  Launcher: 0,
  Turret: 0,
  ...over,
})

// A Redeemer: 8 high, 5 mid, 6 low, 3 rigs.
const REDEEMER = counts({ High: 8, Medium: 5, Low: 6, Rig: 3 })

// Bearing clockwise from 12 o'clock, the same convention ring.ts lays out in.
const bearing = (cell: { x: number; y: number }) =>
  (Math.atan2(cell.x - 0.5, 0.5 - cell.y) * (180 / Math.PI) + 360) % 360
const radius = (cell: { x: number; y: number }) => Math.hypot(cell.x - 0.5, cell.y - 0.5)

test('every slot the hull has gets a cell, fitted or not', () => {
  const cells = ringCells(REDEEMER)
  assert.equal(cells.length, 22)
  assert.deepEqual(
    cells.filter((cell) => cell.family === 'High').map((cell) => cell.index),
    [1, 2, 3, 4, 5, 6, 7, 8]
  )
})

test('each family sits in its own quadrant', () => {
  // The arrangement, stated as the clock says it: highs 12→3, mids 3→6,
  // lows 6→9, rigs 9→12.
  const cells = ringCells(counts({ High: 8, Medium: 5, Low: 6, Rig: 3, SubSystem: 2 }))
  const within = (family: string, from: number, to: number) =>
    cells
      .filter((cell) => cell.family === family)
      .every((cell) => bearing(cell) >= from - 1e-9 && bearing(cell) <= to + 1e-9)

  assert.ok(within('High', 0, 90), 'highs between 12 and 3')
  assert.ok(within('Medium', 90, 180), 'mids between 3 and 6')
  assert.ok(within('Low', 180, 270), 'lows between 6 and 9')
  assert.ok(within('Rig', 270, 360), 'rigs between 9 and 12')
  assert.ok(within('SubSystem', 270, 360), 'subsystems share the rigs’ quadrant')
})

test('every cell lands inside the band, not on a circle', () => {
  const cells = ringCells(REDEEMER)
  assert.ok(cells.every((cell) => radius(cell) >= 0.28 && radius(cell) <= 0.401))
  // The point of a band: the slots do not all share one radius.
  const radii = cells.map(radius)
  assert.ok(Math.max(...radii) - Math.min(...radii) > 0.02, 'the band has depth in use')
})

test('the whole ring stays inside its square, with room for a cell', () => {
  // A cell is 50px on a 438px ring — 0.057 either side of its centre — so a
  // centre past 0.445 would clip the panel edge.
  const cells = ringCells(counts({ High: 8, Medium: 8, Low: 8, Rig: 3, SubSystem: 5 }))
  assert.ok(cells.every((cell) => radius(cell) <= 0.445))
})

test('slot order reads clockwise from the quadrant’s start', () => {
  // pointille answers with an unordered set; the index has to mean something,
  // so HiSlot0 is the first high going clockwise from twelve.
  const high = ringCells(REDEEMER).filter((cell) => cell.family === 'High')
  assert.deepEqual(
    high.map((cell) => cell.index),
    [...high].sort((a, b) => bearing(a) - bearing(b)).map((cell) => cell.index)
  )
})

test('rigs come before subsystems around their shared quadrant', () => {
  const cells = ringCells(counts({ High: 5, Medium: 4, Low: 4, Rig: 3, SubSystem: 4 }))
  const lastRig = Math.max(...cells.filter((c) => c.family === 'Rig').map(bearing))
  const firstSub = Math.min(...cells.filter((c) => c.family === 'SubSystem').map(bearing))
  assert.ok(lastRig <= firstSub)
})

test('the layout is deterministic — the same hull draws the same ring', () => {
  // Lloyd relaxation from a Halton seed: same polygon, same n, same points. A
  // ring that moved between visits would be unusable.
  assert.deepEqual(ringCells(counts({ High: 6, Medium: 4, Low: 5, Rig: 2 })), [
    ...ringCells(counts({ High: 6, Medium: 4, Low: 5, Rig: 2 })),
  ])
})

test('no two slots in a quadrant land on the same point', () => {
  const cells = ringCells(REDEEMER)
  const seen = new Set(cells.map((cell) => `${cell.x.toFixed(6)},${cell.y.toFixed(6)}`))
  assert.equal(seen.size, cells.length)
})

test('a hull with no slots at all draws no cells', () => {
  // A shuttle: no high, mid or low slots, and nothing to lay out.
  assert.deepEqual(ringCells(counts()), [])
})

test('a hull with a single slot still places it in its own quadrant', () => {
  const [only] = ringCells(counts({ High: 1 }))
  assert.ok(bearing(only) >= 0 && bearing(only) <= 90)
  assert.ok(radius(only) >= 0.28 && radius(only) <= 0.401)
})

test('a family with no slots takes no space from the others', () => {
  // The quadrants are fixed, so a hull with no rigs simply leaves that quarter
  // empty rather than letting the highs spread into it.
  const cells = ringCells(counts({ High: 4 }))
  assert.equal(cells.length, 4)
  assert.ok(cells.every((cell) => bearing(cell) <= 90 + 1e-9))
})
