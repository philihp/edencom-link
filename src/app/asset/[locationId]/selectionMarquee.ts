// The geometry half of the asset table's drag-to-select rectangle.
//
// Pure: viewport rectangles in, item ids out. Kept out of the component so the
// only thing left in React is "where did the pointer go", and so the hit test —
// the part that's actually easy to get subtly wrong — can be reasoned about (and
// unit-tested, see test/selectionMarquee.test.ts) without a DOM.
import { filter, map, pipe, union } from 'ramda'

// A rectangle in viewport coordinates, the shape getBoundingClientRect() hands
// back. Only the four edges matter here.
export type Box = { left: number; top: number; right: number; bottom: number }

// The rectangle spanned by two corners, in either drag direction — dragging up
// and to the left has to select the same rows as dragging down and to the right.
export const boxBetween = (from: { x: number; y: number }, to: { x: number; y: number }): Box => ({
  left: Math.min(from.x, to.x),
  top: Math.min(from.y, to.y),
  right: Math.max(from.x, to.x),
  bottom: Math.max(from.y, to.y),
})

// A drag shorter than this is a click that wobbled, not a selection gesture —
// acting on it would clear the selection every time someone clicked the table.
const MIN_DRAG_PX = 5

export const isDrag = (box: Box): boolean => box.right - box.left >= MIN_DRAG_PX || box.bottom - box.top >= MIN_DRAG_PX

// Touching counts: a rectangle dragged across a row's left edge means that row,
// even if it never covered the whole of it. Table rows are wide and short, so
// requiring containment would make the gesture nearly unusable.
export const intersects = (a: Box, b: Box): boolean =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top

// Which rows the rectangle touched, and what the selection becomes.
//
// `additive` is the shift key: shift adds the swept rows to what was already
// selected, and a plain drag replaces the selection outright. Note that shift
// only ever adds — a drag that ends up over an already-selected row leaves it
// selected rather than toggling it off, so a second sweep over the same area is
// idempotent rather than undoing the first.
export const applyMarquee = (
  box: Box,
  rows: Array<{ itemId: string; box: Box }>,
  previous: readonly string[],
  additive: boolean
): string[] => {
  const swept = pipe(
    filter((row: { itemId: string; box: Box }) => intersects(box, row.box)),
    map((row) => row.itemId)
  )(rows)
  return additive ? union(previous, swept) : swept
}
