// The pure half of the mercenary-den map: which systems it draws, and where
// each one sits. Both used to be hand-maintained lists in this directory; they
// are now derived from the mirrored SDE (the stargate graph via
// src/sdeJumps.ts, the coordinates via src/sdeSystems.ts), so the map follows
// whatever dens the account can actually see instead of one curated region.
//
// No I/O here — the page hands the SDE data in and gets a drawing back, which
// is what makes both halves testable (test/mercenaryDenGraph.test.ts).

// Circle radius of a system node, in the user units this module lays out in
// (topology.tsx draws with them, so the two must agree). A system with
// temperate planets gets the larger circle to fit its row of globes on a
// second line.
export const NODE_R = 48
export const NODE_R_BADGE = 60

// Drawn length a stargate link settles at, and how close two nodes may come.
const TARGET_EDGE = 230
const MIN_SEP = 170
// Force relaxation: springs along the links, repulsion between every pair.
// Seeded from real coordinates it only tidies — it pulls a long link in and
// opens a crowded pocket up, which is what keeps the drawing compact enough to
// stay legible when the SVG scales down to the container width.
const SPRING = 0.06
const REPULSION = 4 * MIN_SEP * MIN_SEP
const FORCE_PASSES = 240
const SEPARATION_PASSES = 60
const PAD = NODE_R_BADGE + 10

export type Point = { x: number; y: number }
export type PlanePoint = { systemID: number; x: number; y: number }
export type SystemJumpGraph = Map<number, number[]>
export type Subgraph = { systemIDs: number[]; edges: [number, number][] }

const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)

// Breadth-first expansion out from the seeds, `jumps` hops deep, as a
// tail-recursive frontier walk. Returns the systems reached plus every gate
// between two of them (each link once, low id first), both in ascending id
// order so a render is stable run to run.
//
// `limit` caps how many systems the map may hold — the seeds are never
// dropped, so an account with dens everywhere still sees all of them, but the
// surrounding ring stops growing (the page reads a planet list per drawn
// system, and that query has a row cap of its own).
export const neighbourhood = (
  seeds: Iterable<number>,
  graph: SystemJumpGraph,
  jumps: number,
  limit = Infinity
): Subgraph => {
  const walk = (frontier: number[], seen: Set<number>, depth: number): Set<number> => {
    if (depth <= 0 || frontier.length === 0 || seen.size >= limit) return seen
    const next = [...new Set(frontier.flatMap((id) => graph.get(id) ?? []))]
      .filter((id) => !seen.has(id))
      .slice(0, Math.max(0, limit - seen.size))
    next.forEach((id) => seen.add(id))
    return walk(next, seen, depth - 1)
  }

  const start = [...new Set(seeds)]
  const reached = walk(start, new Set(start), Math.max(0, jumps))
  const systemIDs = [...reached].sort((a, b) => a - b)

  // Each gate appears twice in the graph (a pair of return gates), so collect
  // the links into a keyed map and read the distinct pairs back out.
  const links = new Map<string, [number, number]>()
  systemIDs.forEach((from) =>
    (graph.get(from) ?? [])
      .filter((to) => reached.has(to))
      .forEach((to) => links.set(pairKey(from, to), from < to ? [from, to] : [to, from]))
  )
  const edges = [...links.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return { systemIDs, edges }
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Springs along the links and repulsion between every pair, damped to a stop
// over a fixed number of passes. Deterministic — no randomness anywhere, so a
// render never wanders — and seeded from the systems' real positions, so the
// result stays recognisable as the map it started from.
const forceRelax = (points: Point[], links: Array<[number, number]>): Point[] => {
  const spread = points.map((p) => ({ ...p }))
  Array.from({ length: FORCE_PASSES }).forEach((_unused, pass) => {
    const damp = 0.9 * (1 - pass / FORCE_PASSES) + 0.1
    const forces = spread.map(() => ({ x: 0, y: 0 }))
    spread.forEach((a, i) =>
      spread.slice(i + 1).forEach((b, offset) => {
        const j = i + 1 + offset
        const d = Math.max(distance(a, b), 1)
        const push = REPULSION / (d * d)
        forces[i].x -= ((b.x - a.x) / d) * push
        forces[i].y -= ((b.y - a.y) / d) * push
        forces[j].x += ((b.x - a.x) / d) * push
        forces[j].y += ((b.y - a.y) / d) * push
      })
    )
    links.forEach(([i, j]) => {
      const d = Math.max(distance(spread[i], spread[j]), 1)
      const pull = (d - TARGET_EDGE) * SPRING
      forces[i].x += ((spread[j].x - spread[i].x) / d) * pull
      forces[i].y += ((spread[j].y - spread[i].y) / d) * pull
      forces[j].x -= ((spread[j].x - spread[i].x) / d) * pull
      forces[j].y -= ((spread[j].y - spread[i].y) / d) * pull
    })
    // Cap a single step at half the minimum separation: a node crossing the
    // map in one pass is how a force layout tears itself apart.
    spread.forEach((p, i) => {
      const f = forces[i]
      const length = Math.max(Math.hypot(f.x, f.y), 0.0001)
      const step = Math.min(length * damp, MIN_SEP / 2)
      p.x += (f.x / length) * step
      p.y += (f.y / length) * step
    })
  })
  return spread
}

// Push apart every pair still closer than MIN_SEP — the last word on overlap,
// after the forces have had their say. Two systems at the very same projected
// point (the plane drops one axis, so it happens) are separated along an angle
// derived from their index, keeping the whole thing deterministic.
const separate = (points: Point[]): Point[] => {
  const spread = points.map((p) => ({ ...p }))
  Array.from({ length: SEPARATION_PASSES }).forEach(() => {
    spread.forEach((a, i) => {
      spread.slice(i + 1).forEach((b, offset) => {
        const j = i + 1 + offset
        const d = distance(a, b)
        if (d >= MIN_SEP) return
        const angle = ((i * 7 + j * 13) % 360) * (Math.PI / 180)
        const ux = d === 0 ? Math.cos(angle) : (b.x - a.x) / d
        const uy = d === 0 ? Math.sin(angle) : (b.y - a.y) / d
        const push = (MIN_SEP - d) / 2
        a.x -= ux * push
        a.y -= uy * push
        b.x += ux * push
        b.y += uy * push
      })
    })
  })
  return spread
}

// Lay the systems out on the drawing plane: scale real distances so a typical
// gate reads as TARGET_EDGE, relax the result, then frame it. The input is
// already a 2-D projection (the caller drops the galaxy's "up" axis), so the
// drawing keeps real geography — nodes sit where the systems really are
// relative to each other, give or take the tidying.
export type Layout = { positions: Record<number, Point>; viewBox: string; width: number; height: number }

export const layout = (systems: PlanePoint[], edges: [number, number][]): Layout => {
  if (systems.length === 0)
    return { positions: {}, viewBox: `0 0 ${PAD * 2} ${PAD * 2}`, width: PAD * 2, height: PAD * 2 }

  const raw: Point[] = systems.map(({ x, y }) => ({ x, y }))
  const index = new Map(systems.map(({ systemID }, i) => [systemID, i]))

  // Zoom: a typical gate becomes TARGET_EDGE long. With no gate to measure
  // (one system, or seeds with no link between them) fall back to the
  // bounding box, and to 1 when every system projects to the same point —
  // the relaxation opens those up.
  const lengths = edges
    .map(([from, to]) => [index.get(from), index.get(to)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] != null && pair[1] != null)
    .map(([a, b]) => distance(raw[a], raw[b]))
    .filter((d) => d > 0)
  const span = Math.max(
    Math.max(...raw.map((p) => p.x)) - Math.min(...raw.map((p) => p.x)),
    Math.max(...raw.map((p) => p.y)) - Math.min(...raw.map((p) => p.y))
  )
  const scale =
    lengths.length > 0
      ? TARGET_EDGE / median(lengths)
      : span > 0
        ? (TARGET_EDGE * Math.max(1, systems.length - 1)) / span
        : 1

  const linkIndexes = edges
    .map(([from, to]) => [index.get(from), index.get(to)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] != null && pair[1] != null)
    .map(([a, b]): [number, number] => [a, b])
  const spread = separate(
    forceRelax(
      raw.map(({ x, y }) => ({ x: x * scale, y: y * scale })),
      linkIndexes
    )
  )

  const minX = Math.min(...spread.map((p) => p.x))
  const minY = Math.min(...spread.map((p) => p.y))
  const framed = spread.map(({ x, y }) => ({ x: Math.round(x - minX + PAD), y: Math.round(y - minY + PAD) }))
  const width = Math.max(...framed.map((p) => p.x)) + PAD
  const height = Math.max(...framed.map((p) => p.y)) + PAD

  return {
    positions: Object.fromEntries(systems.map(({ systemID }, i) => [systemID, framed[i]])),
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
  }
}

// How big a user unit is drawn on screen. A map is as long as the systems in
// it really are — a chain of a dozen systems is a chain, not a blob — so the
// drawing keeps a fixed density and the page scrolls it sideways when it
// outgrows the column, exactly as the den table does. Squeezing it to the
// column instead is what turns the labels into specks.
export const PX_PER_UNIT = 0.46
