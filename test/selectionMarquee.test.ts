// Unit coverage for the asset table's drag-to-select geometry.
//
// The hit test is the part that's quietly wrong if it's wrong: dragging up-left
// has to select what dragging down-right would, a row the rectangle merely
// clipped counts, and a click that wobbled must not clear the selection. None
// of that needs a DOM, so it's pinned here rather than found by hand later.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyMarquee,
  boxBetween,
  intersects,
  isDrag,
  type Box,
} from '../src/app/asset/[locationId]/selectionMarquee.ts'

// Three stacked rows, 20px tall, the way a table lays them out.
const row = (itemId: string, top: number): { itemId: string; box: Box } => ({
  itemId,
  box: { left: 100, top, right: 500, bottom: top + 20 },
})
const ROWS = [row('a', 0), row('b', 20), row('c', 40)]

test('boxBetween normalizes either drag direction', () => {
  const downRight = boxBetween({ x: 10, y: 10 }, { x: 40, y: 50 })
  const upLeft = boxBetween({ x: 40, y: 50 }, { x: 10, y: 10 })
  assert.deepEqual(downRight, { left: 10, top: 10, right: 40, bottom: 50 })
  assert.deepEqual(upLeft, downRight)
})

test('a wobble is not a drag, a real sweep is', () => {
  assert.equal(isDrag(boxBetween({ x: 10, y: 10 }, { x: 12, y: 13 })), false)
  assert.equal(isDrag(boxBetween({ x: 10, y: 10 }, { x: 10, y: 30 })), true)
  assert.equal(isDrag(boxBetween({ x: 10, y: 10 }, { x: 40, y: 10 })), true)
})

test('touching a row counts — the rectangle need not contain it', () => {
  // A thin sliver over the left edge of the middle row only.
  const sliver: Box = { left: 90, top: 25, right: 110, bottom: 30 }
  assert.equal(intersects(sliver, ROWS[1].box), true)
  assert.equal(intersects(sliver, ROWS[0].box), false)
})

test('a plain drag replaces the selection', () => {
  const box = boxBetween({ x: 200, y: 25 }, { x: 300, y: 55 })
  assert.deepEqual(applyMarquee(box, ROWS, ['a'], false), ['b', 'c'])
})

test('a shift-drag adds to it, without duplicating what was already there', () => {
  const box = boxBetween({ x: 200, y: 25 }, { x: 300, y: 55 })
  assert.deepEqual(applyMarquee(box, ROWS, ['a', 'b'], true), ['a', 'b', 'c'])
})

test('a drag over nothing clears the selection, but only when not additive', () => {
  const empty = boxBetween({ x: 600, y: 0 }, { x: 700, y: 60 })
  assert.deepEqual(applyMarquee(empty, ROWS, ['a'], false), [])
  assert.deepEqual(applyMarquee(empty, ROWS, ['a'], true), ['a'])
})
