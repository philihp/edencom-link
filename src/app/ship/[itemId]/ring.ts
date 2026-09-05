import { pointille } from 'pointille'

import type { SlotType } from './esf/fit'
import type { SlotCounts } from './esf/attributes'

// Where every slot sits on the fitting ring (stage 3 of docs/custom-fit-ui.md).
//
// Pure geometry, deliberately away from the component that draws it: the only
// interesting thing here is the arithmetic, and it's the part worth pinning in
// a test. Positions come back as *fractions* of the ring's bounding square
// rather than pixels, so the markup positions cells in percentages and one
// ring scales from a 438px desktop panel down to a phone without recomputing.
//
// The ring is a BAND rather than a line, and each family owns a quadrant of it:
//
//     12 → 3   high slots
//      3 → 6   mid slots
//      6 → 9   low slots
//      9 → 12  rigs, and subsystems behind them
//
// Within its quadrant a family's slots are spread by `pointille` — Lloyd's
// algorithm relaxing points to the centroids of their Voronoi cells, clipped to
// the polygon. That is what "evenly spaced inside an area" means, and it is a
// better answer than dividing an arc: the band has two dimensions, so eight
// high slots use its depth instead of crowding a single circle.
//
// Two properties make it safe to do this at render time rather than by hand:
//
//   * It is DETERMINISTIC. Same polygon, same n, byte-identical points — so a
//     hull's ring looks the same on every visit and in every test.
//   * `n` is the hull's slot COUNT, not how many are filled. The ring draws an
//     empty slot as readily as a fitted one, so fitting a module changes
//     nothing about the layout. Relaxation would otherwise move every icon
//     whenever you fitted something, which is the one thing a fitting screen
//     must not do.

export type RingCell = {
  family: SlotType
  // 1-based, the same numbering the engine gives a module's slot.
  index: number
  x: number
  y: number
}

// The band, as fractions of the square. Its outer edge leaves room for half a
// cell plus the family labels; ~50px of depth on a 438px ring is what turns the
// old circle into something with an inside.
const BAND_OUTER = 0.4
const BAND_INNER = 0.286

// Which quadrant each family owns, clockwise from 12 o'clock. Rigs and
// subsystems share the last one and are laid out together, so the two never
// land on top of each other — no hull has many of both, and they were the two
// "inner" families before the band existed.
const SECTORS: { families: SlotType[]; from: number; to: number }[] = [
  { families: ['High'], from: 0, to: 90 },
  { families: ['Medium'], from: 90, to: 180 },
  { families: ['Low'], from: 180, to: 270 },
  { families: ['Rig', 'SubSystem'], from: 270, to: 360 },
]

// Degrees clockwise from 12 o'clock → a point on the circle, in the fractional
// coordinates above (y grows downward, as it does on screen).
const pointAt = (radius: number, degrees: number): { x: number; y: number } => {
  const radians = (degrees * Math.PI) / 180
  return { x: 0.5 + radius * Math.sin(radians), y: 0.5 - radius * Math.cos(radians) }
}

// One quadrant of the band as a closed polygon: out along the outer arc, in,
// and back along the inner one. Enough segments that the arcs read as curves to
// the Voronoi clipping rather than as a coarse wedge.
const ARC_STEPS = 24

const sectorPolygon = (from: number, to: number): [number, number][] => {
  const span = to - from
  const outer = Array.from({ length: ARC_STEPS + 1 }, (_, i) => pointAt(BAND_OUTER, from + (span * i) / ARC_STEPS))
  const inner = Array.from({ length: ARC_STEPS + 1 }, (_, i) => pointAt(BAND_INNER, to - (span * i) / ARC_STEPS))
  return [...outer, ...inner].map(({ x, y }): [number, number] => [x, y])
}

// Bearing of a point clockwise from 12 o'clock, in [0, 360).
const bearingOf = (x: number, y: number): number => (Math.atan2(x - 0.5, 0.5 - y) * (180 / Math.PI) + 360) % 360

// pointille answers with an unordered set — the relaxation has no notion of
// which point is slot 1. Reading them clockwise from the quadrant's start is
// what keeps the index meaningful: HiSlot0 is the first high going clockwise
// from twelve, as it was when the slots sat on an arc. Radius breaks a tie so
// the order is total, and so it cannot depend on the order pointille happened
// to return.
const clockwiseWithin = (from: number, points: readonly (readonly [number, number])[]) =>
  [...points]
    .map(([x, y]) => ({ x, y, along: (bearingOf(x, y) - from + 360) % 360, radius: Math.hypot(x - 0.5, y - 0.5) }))
    .sort((a, b) => a.along - b.along || a.radius - b.radius)

// A hull's layout never changes, so it is computed once. Keyed on the counts
// themselves rather than on the hull: two hulls with the same slots get the
// same ring, which is true and also what makes the key cheap.
const cache = new Map<string, RingCell[]>()

const layOut = (counts: SlotCounts): RingCell[] =>
  SECTORS.flatMap(({ families, from, to }) => {
    const total = families.reduce((sum, family) => sum + counts[family], 0)
    if (total === 0) return []

    const placed = clockwiseWithin(from, pointille(sectorPolygon(from, to), total))

    // Hand the sorted points out family by family, so a quadrant shared by rigs
    // and subsystems reads rigs-then-subsystems around the arc. `taken` is how
    // far down the sorted list the previous family got.
    return families.reduce<{ cells: RingCell[]; taken: number }>(
      ({ cells, taken }, family) => ({
        cells: [
          ...cells,
          ...Array.from({ length: counts[family] }, (_, i) => ({
            family,
            index: i + 1,
            x: placed[taken + i].x,
            y: placed[taken + i].y,
          })),
        ],
        taken: taken + counts[family],
      }),
      { cells: [], taken: 0 }
    ).cells
  })

// Every slot the hull has, fitted or not — an empty slot is a cell too, since
// "two highs free" is one of the things the ring is for.
export const ringCells = (counts: SlotCounts): RingCell[] => {
  const key = SECTORS.flatMap(({ families }) => families.map((family) => `${family}:${counts[family]}`)).join(',')
  const held = cache.get(key)
  if (held) return held
  const cells = layOut(counts)
  cache.set(key, cells)
  return cells
}
