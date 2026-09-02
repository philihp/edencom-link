// Unit coverage for the pure half of the mercenary-den map: which systems it
// draws (breadth-first out from the dens the account can see) and where each
// one lands. Both replace hand-maintained lists, so what is pinned here is
// what those lists used to guarantee by hand — a link is drawn once, nodes
// never overlap, and the same input always draws the same picture.
import assert from 'node:assert/strict'
import test from 'node:test'

import { NODE_R_BADGE, layout, neighbourhood, type SystemJumpGraph } from '../src/app/mercenary-dens/graph.ts'

// A—B—C—D chain plus a spur E off B. Both directions, as CCP ships gates.
const chain: SystemJumpGraph = new Map([
  [1, [2]],
  [2, [1, 3, 5]],
  [3, [2, 4]],
  [4, [3]],
  [5, [2]],
])

test('a seed with no jumps is the whole map', () => {
  const { systemIDs, edges } = neighbourhood([3], chain, 0)
  assert.deepEqual(systemIDs, [3])
  assert.deepEqual(edges, [])
})

test('one jump reaches the neighbours and draws the links between them', () => {
  const { systemIDs, edges } = neighbourhood([2], chain, 1)
  assert.deepEqual(systemIDs, [1, 2, 3, 5])
  assert.deepEqual(edges, [
    [1, 2],
    [2, 3],
    [2, 5],
  ])
})

test('two jumps walk the chain out', () => {
  assert.deepEqual(neighbourhood([1], chain, 2).systemIDs, [1, 2, 3, 5])
  assert.deepEqual(neighbourhood([1], chain, 3).systemIDs, [1, 2, 3, 4, 5])
})

test('several seeds merge into one map, each link drawn once', () => {
  const { systemIDs, edges } = neighbourhood([1, 4], chain, 1)
  assert.deepEqual(systemIDs, [1, 2, 3, 4])
  assert.deepEqual(edges, [
    [1, 2],
    [2, 3],
    [3, 4],
  ])
})

test('a link to a system off the map is not drawn', () => {
  const { edges } = neighbourhood([3], chain, 0)
  assert.deepEqual(edges, [])
})

test('a seed the graph has never heard of still appears', () => {
  // A system with no gates in the mirror (or a mirror that has not landed yet)
  // must not vanish from the map — the den is real either way.
  const { systemIDs, edges } = neighbourhood([99], chain, 1)
  assert.deepEqual(systemIDs, [99])
  assert.deepEqual(edges, [])
})

const spaced = (systems: Parameters<typeof layout>[0], edges: Parameters<typeof layout>[1]) => {
  const { positions } = layout(systems, edges)
  const points = Object.values(positions)
  return points.flatMap((a, i) => points.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y)))
}

test('nodes never overlap, however close the real systems are', () => {
  const systems = [
    { systemID: 1, x: 0, y: 0 },
    { systemID: 2, x: 1e12, y: 0 }, // a rounding error apart on a 1e17 scale
    { systemID: 3, x: 0, y: 0 }, // and two at the very same projected point
  ]
  spaced(systems, [[1, 2]]).forEach((d) => assert.ok(d >= NODE_R_BADGE * 2, `nodes ${d} apart`))
})

test('the drawing frames every node inside the viewBox', () => {
  const systems = [
    { systemID: 1, x: -5e16, y: 2e16 },
    { systemID: 2, x: 1e16, y: -3e16 },
    { systemID: 3, x: 4e16, y: 5e16 },
  ]
  const { positions, viewBox } = layout(systems, [
    [1, 2],
    [2, 3],
  ])
  const [, , width, height] = viewBox.split(' ').map(Number)
  Object.values(positions).forEach(({ x, y }) => {
    assert.ok(x >= NODE_R_BADGE && x <= width - NODE_R_BADGE, `x ${x} within ${width}`)
    assert.ok(y >= NODE_R_BADGE && y <= height - NODE_R_BADGE, `y ${y} within ${height}`)
  })
})

test('real geography survives: the far system stays the far one', () => {
  const systems = [
    { systemID: 1, x: 0, y: 0 },
    { systemID: 2, x: 3e16, y: 0 },
    { systemID: 3, x: 9e16, y: 0 },
  ]
  const { positions } = layout(systems, [
    [1, 2],
    [2, 3],
  ])
  assert.ok(positions[3].x - positions[2].x > positions[2].x - positions[1].x)
})

test('the same input always draws the same picture', () => {
  const systems = [
    { systemID: 1, x: 0, y: 0 },
    { systemID: 2, x: 2e16, y: 1e16 },
    { systemID: 3, x: 0, y: 0 },
    { systemID: 4, x: -1e16, y: 4e16 },
  ]
  const edges: [number, number][] = [
    [1, 2],
    [2, 4],
  ]
  assert.deepEqual(layout(systems, edges), layout(systems, edges))
})

test('an empty map is a valid (if pointless) drawing', () => {
  const { positions, viewBox } = layout([], [])
  assert.deepEqual(positions, {})
  assert.match(viewBox, /^0 0 \d+ \d+$/)
})

test('one system alone is centred in its own frame', () => {
  const { positions, viewBox } = layout([{ systemID: 7, x: 4e16, y: -2e16 }], [])
  const [, , width, height] = viewBox.split(' ').map(Number)
  assert.deepEqual(positions[7], { x: width / 2, y: height / 2 })
})

test('the limit caps the ring around the seeds without dropping a seed', () => {
  const { systemIDs } = neighbourhood([1, 4], chain, 1, 3)
  assert.equal(systemIDs.length, 3)
  assert.ok(systemIDs.includes(1) && systemIDs.includes(4), 'both seeds survive the cap')
})

test('a limit below the seed count still keeps every seed', () => {
  assert.deepEqual(neighbourhood([1, 4], chain, 2, 1).systemIDs, [1, 4])
})
