// The fitting ring's geometry: which slot lands where. Positions come back as
// fractions of the ring's square rather than pixels, so what's worth pinning is
// the arrangement — highs across the top, mids down the right, lows along the
// bottom, rigs on an inner arc under the hull — and that it holds for hulls
// whose slot counts are nothing like a battleship's.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ringCells } from '../src/app/item/[itemId]/ring.ts'
import type { SlotCounts } from '../src/app/item/[itemId]/esf/attributes.ts'

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

test('every slot the hull has gets a cell, fitted or not', () => {
  const cells = ringCells(REDEEMER)
  assert.equal(cells.length, 22)
  assert.deepEqual(
    cells.filter((cell) => cell.family === 'High').map((cell) => cell.index),
    [1, 2, 3, 4, 5, 6, 7, 8]
  )
})

test('the high slots straddle twelve o’clock', () => {
  const high = ringCells(REDEEMER).filter((cell) => cell.family === 'High')
  // Above the centre line, and spread either side of it.
  assert.ok(high.every((cell) => cell.y < 0.5))
  assert.ok(high[0].x < 0.5)
  assert.ok(high[high.length - 1].x > 0.5)
})

test('mids run down the right, lows along the bottom and back up the left', () => {
  const cells = ringCells(REDEEMER)
  const mid = cells.filter((cell) => cell.family === 'Medium')
  const low = cells.filter((cell) => cell.family === 'Low')

  assert.ok(mid.every((cell) => cell.x > 0.5))
  // Clockwise: each mid is lower than the one before it.
  assert.ok(mid.every((cell, i) => i === 0 || cell.y > mid[i - 1].y))
  assert.ok(low[0].y > 0.5)
  assert.ok(low[low.length - 1].x < 0.5)
})

test('rigs sit on an inner arc centred under the hull', () => {
  const rigs = ringCells(counts({ High: 8, Medium: 5, Low: 6, Rig: 3 })).filter((cell) => cell.family === 'Rig')
  assert.equal(rigs.length, 3)
  // Closer to the middle than any outer cell, and below it.
  assert.ok(rigs.every((cell) => cell.y > 0.5 && cell.y < 0.75))
  // The middle rig hangs straight down from the hub.
  assert.ok(Math.abs(rigs[1].x - 0.5) < 1e-9)
})

test('subsystems take the inner arc at the top, opposite the rigs', () => {
  const cells = ringCells(counts({ High: 6, Medium: 5, Low: 5, Rig: 3, SubSystem: 4 }))
  const subs = cells.filter((cell) => cell.family === 'SubSystem')
  assert.equal(subs.length, 4)
  assert.ok(subs.every((cell) => cell.y < 0.5))
})

test('the arcs are shared out by slot count, so the ring reads as the fit', () => {
  // Six highs and two mids: the high arc is the wider one, by three to one.
  const cells = ringCells(counts({ High: 6, Medium: 2, Low: 4 }))
  const spread = (family: string) => {
    const own = cells.filter((cell) => cell.family === family)
    return Math.hypot(own[own.length - 1].x - own[0].x, own[own.length - 1].y - own[0].y)
  }
  assert.ok(spread('High') > spread('Medium'))
})

test('a hull with no slots at all draws no cells', () => {
  // A shuttle: no high, mid or low slots, and nothing to lay out.
  assert.deepEqual(ringCells(counts()), [])
})

test('a hull with only high slots still centres them on the top', () => {
  const cells = ringCells(counts({ High: 3 }))
  assert.equal(cells.length, 3)
  assert.ok(Math.abs(cells[1].x - 0.5) < 1e-9)
  assert.ok(cells[1].y < 0.5)
})
