import type { SlotType } from './esf/fit'
import type { SlotCounts } from './esf/attributes'

// Where every slot sits on the fitting ring (stage 3 of docs/custom-fit-ui.md).
//
// Pure geometry, deliberately away from the component that draws it: the only
// interesting thing here is the arithmetic, and it's the part worth pinning in
// a test. Positions come back as *fractions* of the ring's bounding square
// rather than pixels, so the markup positions cells in percentages and one
// ring scales from a 438px desktop panel down to a phone without recomputing.

export type RingCell = {
  family: SlotType
  // 1-based, the same numbering the engine gives a module's slot.
  index: number
  x: number
  y: number
}

// Radii as fractions of the square. High/mid/low ride the outer ring; rigs and
// subsystems sit on an inner one, which is where the fitting window puts them
// and what keeps a T3's twelve-plus slots from crowding a single arc.
const OUTER_RADIUS = 0.39
const INNER_RADIUS = 0.235

// Clear space between two neighbouring families on the outer ring, so the eye
// can count "these six are the highs" without reading the labels.
const FAMILY_GAP_DEGREES = 24

// Clockwise from 12 o'clock, with the high slots straddling the top — the
// fitting window's own arrangement.
const OUTER_FAMILIES: SlotType[] = ['High', 'Medium', 'Low']

// Inner families are few and fixed-pitch, so they're placed around a centre
// bearing instead of sharing out the circle: subsystems at the top, rigs at
// the bottom, under the low slots they modify.
const INNER_FAMILIES: [SlotType, number][] = [
  ['SubSystem', 0],
  ['Rig', 180],
]
const INNER_STEP_DEGREES = 22

// Degrees clockwise from 12 o'clock → a point on the circle, in the fractional
// coordinates above (y grows downward, as it does on screen).
const pointAt = (radius: number, degrees: number): { x: number; y: number } => {
  const radians = (degrees * Math.PI) / 180
  return { x: 0.5 + radius * Math.sin(radians), y: 0.5 - radius * Math.cos(radians) }
}

// The outer three families share the circle in proportion to how many slots
// each has, so a hull with six highs and two mids reads as such at a glance —
// the arcs are the counts. Fixed gaps come off the top first.
const outerCells = (counts: SlotCounts): RingCell[] => {
  const total = OUTER_FAMILIES.reduce((sum, family) => sum + counts[family], 0)
  // A shuttle has no high, mid or low slots at all; there's nothing to lay out.
  if (total === 0) return []

  const available = 360 - FAMILY_GAP_DEGREES * OUTER_FAMILIES.length
  const spanOf = (family: SlotType) => (counts[family] / total) * available

  // Start half the high-slot arc anticlockwise of 12 o'clock, so that family
  // ends up centred on the top however many slots it has.
  let cursor = -spanOf('High') / 2

  return OUTER_FAMILIES.flatMap((family) => {
    const count = counts[family]
    const span = spanOf(family)
    const step = count === 0 ? 0 : span / count
    const cells = Array.from({ length: count }, (_, i) => ({
      family,
      index: i + 1,
      // +0.5 centres each cell in its own share of the arc, so the first and
      // last sit inside the family's span rather than on its boundary.
      ...pointAt(OUTER_RADIUS, cursor + step * (i + 0.5)),
    }))
    cursor += span + FAMILY_GAP_DEGREES
    return cells
  })
}

const innerCells = (counts: SlotCounts): RingCell[] =>
  INNER_FAMILIES.flatMap(([family, centre]) => {
    const count = counts[family]
    const start = centre - (INNER_STEP_DEGREES * (count - 1)) / 2
    return Array.from({ length: count }, (_, i) => ({
      family,
      index: i + 1,
      ...pointAt(INNER_RADIUS, start + INNER_STEP_DEGREES * i),
    }))
  })

// Every slot the hull has, fitted or not — an empty slot is a cell too, since
// "two highs free" is one of the things the ring is for.
export const ringCells = (counts: SlotCounts): RingCell[] => [...outerCells(counts), ...innerCells(counts)]
