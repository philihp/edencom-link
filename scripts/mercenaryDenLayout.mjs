// Generator for the Mercenary Dens topology layout (src/app/mercenary-dens/data.ts's
// NODE_POSITIONS). The map is a fixed, hand-maintained set of systems, so rather
// than hand-place each node we derive the layout from CCP's real universe geometry
// and then untangle it into a clean, crossing-free drawing:
//
//   1. Seed from each system's true 3-D position in the SDE (position.x/y/z, in
//      metres), projected onto the EVE galaxy-map plane (x, z) — the same top-down
//      plane the in-game star map uses (y is galactic "up" and is dropped). This
//      gives the untangler a starting point that already resembles real geography.
//   2. Simulated annealing to a planar (zero edge-crossing) embedding — crossings
//      are penalised far more heavily than spacing, and the anneal is restarted
//      from the seed with fresh randomness until it finds a layout with no
//      crossings (the graph is planar, so one exists).
//   3. Planarity-preserving force relaxation — spring + repulsion forces even out
//      spacing and shorten long edges, but any node move that would re-introduce a
//      crossing is rejected, so the result stays crossing-free while looking tidy.
//
// A seeded PRNG makes the whole thing deterministic. The raw SDE coordinates are
// embedded below (build 3439610, mapSolarSystems.jsonl) so this reproduces the
// layout with no network. When the system list changes, add the new system's
// coordinates here (from the SDE mirror) and re-run:
// `node scripts/mercenaryDenLayout.mjs` prints the NODE_POSITIONS block and the
// viewBox to paste into data.ts.

// system -> true SDE position (metres). x/z are the map plane; y is dropped.
const SDE = {
  'X1-IZ0': { x: 171171935326324900, y: 53511485392798040, z: -102862501276065060 },
  'RXA-W1': { x: 193948559099707870, y: 50851408196024400, z: -12333597236449888 },
  'JVA-FE': { x: 198427175673494100, y: 41161224814118310, z: -10778731502454926 },
  'QFU-4S': { x: 209066297558409950, y: 38688938954102880, z: -6712360799203207 },
  '8P-LKL': { x: 204484891374719700, y: 36437385743242580, z: -7403161491288392 },
  'VK6-EZ': { x: 203343817824769600, y: 52565219907672260, z: -9826451647896338 },
  'QQGH-G': { x: 210963814943210050, y: 30372070063864730, z: -7077866438315849 },
  'L-WG68': { x: 201916696063245220, y: 50736928441371150, z: -18686653743254270 },
  'Q-UVY6': { x: 202932438680521760, y: 52640885034809930, z: -2781041928261040 },
  'G-VFVB': { x: 220869049030099070, y: 37106486204886936, z: 5243324886005265 },
  'VX1-HV': { x: 219162735621428900, y: 26292615556408464, z: -16323327717496584 },
  'HIK-MC': { x: 203689044365640770, y: 48475035465904290, z: -24536647548581096 },
  'GZM-KB': { x: 199835316816933660, y: 59463517653913704, z: -20492733104947384 },
  'KPI-OW': { x: 208154374507014460, y: 62662980505062264, z: 1649674679063157 },
  'K-XJJT': { x: 225656166856067800, y: 21228040771125750, z: -9665465845093836 },
  'JNG7-K': { x: 221827423097293820, y: 34347564132748796, z: -16854084280841878 },
  'FO1U-K': { x: 215946521415700830, y: 28587604604950180, z: -24389608453670748 },
  'Y4OK-W': { x: 211359788888111330, y: 34207292055471492, z: -32025588282584720 },
  '5LAJ-8': { x: 229561774760379800, y: 44219595339289440, z: -26665320167901692 },
  'E4-E8W': { x: 216286333330820030, y: 44384821307826940, z: -23672523652061692 },
  'P-NI4K': { x: 226659211587028100, y: 15292487048664492, z: -10702259107908420 },
  '8-SPNN': { x: 234031313007514430, y: -28078812574864068, z: -69124600091398140 },
  '6U-1RX': { x: 216910471959533860, y: 23466093812617684, z: -29019564188694960 },
  'B9EA-G': { x: 230494208650080740, y: 40207907627548120, z: -22668555639034884 },
  'E-BFLT': { x: 212350179873990270, y: 43333257516501430, z: -27880278348021410 },
  'GF-GR7': { x: 246656763912719260, y: 25365571111695080, z: -17824990705925340 },
  'HPMN-V': { x: 246779313964254820, y: 32005375936682940, z: -12339167275315514 },
  'Z19-B8': { x: 252585440839753900, y: 23954865608527100, z: -13282653880457742 },
  'DVN6-0': { x: 249091241506871140, y: 310275834838564, z: -18695870010339330 },
  'XR-ZL7': { x: 253336190489240130, y: 20636315788637540, z: -18391475707569010 },
  'U1-VHY': { x: 254061456084241060, y: -7919280460723185, z: -17995270022511176 },
  '8OYE-Z': { x: 268790209585249440, y: 13799263929462480, z: -49434666198436520 },
  'XUPK-Z': { x: 279401404948516450, y: -27949197551526540, z: -785595785642374 },
}

// Undirected links between systems (mirror of data.ts LINKS), for the edge springs.
const LINKS = {
  'X1-IZ0': ['RXA-W1'],
  'RXA-W1': ['JVA-FE'],
  'JVA-FE': ['RXA-W1', 'QFU-4S', '8P-LKL', 'VK6-EZ'],
  'QFU-4S': ['8P-LKL', 'QQGH-G'],
  '8P-LKL': ['JVA-FE', 'QFU-4S', 'QQGH-G'],
  'VK6-EZ': ['JVA-FE', 'Q-UVY6', 'QQGH-G', 'L-WG68'],
  'L-WG68': ['VK6-EZ', 'HIK-MC', 'GZM-KB'],
  'HIK-MC': ['Y4OK-W', '5LAJ-8', 'E4-E8W'],
  'Y4OK-W': ['6U-1RX'],
  '6U-1RX': ['FO1U-K'],
  'FO1U-K': ['VX1-HV'],
  'VX1-HV': ['QQGH-G', 'K-XJJT', 'JNG7-K'],
  'K-XJJT': ['P-NI4K'],
  'QQGH-G': ['G-VFVB'],
  'Q-UVY6': ['KPI-OW'],
  'JNG7-K': ['8-SPNN'],
  '5LAJ-8': ['B9EA-G'],
  'E4-E8W': ['E-BFLT', 'B9EA-G'],
  'B9EA-G': ['GF-GR7'],
  'GF-GR7': ['HPMN-V', 'Z19-B8', 'DVN6-0'],
  'DVN6-0': ['U1-VHY', '8OYE-Z'],
  'XR-ZL7': ['HPMN-V', 'Z19-B8', 'XUPK-Z'],
}

const STAGING = 'X1-IZ0'

// ── Layout parameters ────────────────────────────────────────────────────────
const NODE_NAMES = Object.keys(SDE)
const IDX = Object.fromEntries(NODE_NAMES.map((n, i) => [n, i]))
const REST_LEN = 150 // ideal drawn distance along a link
const MIN_SEP = 92 // desired minimum centre-to-centre spacing (node badge Ø ≈ 60)
const SA_ITERS = 300000 // annealing steps per restart
const SA_RESTARTS = 30 // re-seeded attempts to find a crossing-free embedding
const FDL_PASSES = 900 // planarity-preserving relaxation passes

// Deterministic PRNG (mulberry32) so the layout is reproducible run-to-run.
let seed = 0
const setSeed = (s) => {
  seed = s | 0
}
const rnd = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Distinct undirected edges as index pairs.
const edges = (() => {
  const seen = new Set()
  const out = []
  for (const [from, tos] of Object.entries(LINKS)) {
    for (const to of tos) {
      const k = [from, to].sort().join('|')
      if (seen.has(k)) continue
      seen.add(k)
      out.push([IDX[from], IDX[to]])
    }
  }
  return out
})()
const incident = NODE_NAMES.map(() => [])
edges.forEach(([a, b], ei) => {
  incident[a].push(ei)
  incident[b].push(ei)
})

// Seed positions: true 3-D position projected onto the map plane (x, z),
// normalised to a ~900px working box.
const seedProjection = (() => {
  const px = NODE_NAMES.map((n) => SDE[n].x)
  const pz = NODE_NAMES.map((n) => SDE[n].z)
  const lo = Math.min(...px)
  const loZ = Math.min(...pz)
  const span = Math.max(Math.max(...px) - lo, Math.max(...pz) - loZ)
  const scale = 900 / span
  return {
    x: NODE_NAMES.map((n) => (SDE[n].x - lo) * scale),
    y: NODE_NAMES.map((n) => (SDE[n].z - loZ) * scale),
  }
})()

const X = seedProjection.x.slice()
const Y = seedProjection.y.slice()

// Do two edges (given as index pairs) properly cross? Segments sharing an
// endpoint don't count.
const ccw = (ax, ay, bx, by, cx, cy) => (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)
const segCross = (i1, j1, i2, j2) => {
  if (i1 === i2 || i1 === j2 || j1 === i2 || j1 === j2) return false
  const d1 = ccw(X[i1], Y[i1], X[j1], Y[j1], X[i2], Y[i2])
  const d2 = ccw(X[i1], Y[i1], X[j1], Y[j1], X[j2], Y[j2])
  const d3 = ccw(X[i2], Y[i2], X[j2], Y[j2], X[i1], Y[i1])
  const d4 = ccw(X[i2], Y[i2], X[j2], Y[j2], X[j1], Y[j1])
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0
}
const crossings = () => {
  let c = 0
  for (let a = 0; a < edges.length; a++)
    for (let b = a + 1; b < edges.length; b++) if (segCross(edges[a][0], edges[a][1], edges[b][0], edges[b][1])) c++
  return c
}
// Penalty for nodes closer than MIN_SEP (spacing) and for edges longer/shorter
// than REST_LEN (compactness) — the tie-breakers once crossings are handled.
const spacingPenalty = () => {
  let p = 0
  for (let i = 0; i < NODE_NAMES.length; i++)
    for (let j = i + 1; j < NODE_NAMES.length; j++) {
      const d = Math.hypot(X[i] - X[j], Y[i] - Y[j])
      if (d < MIN_SEP) p += MIN_SEP - d
    }
  let e = 0
  for (const [a, b] of edges) {
    const diff = Math.hypot(X[a] - X[b], Y[a] - Y[b]) - REST_LEN
    e += diff > 0 ? diff * diff * 0.02 : -diff * 0.4
  }
  return p * 14 + e
}
const cost = () => crossings() * 200000 + spacingPenalty()

// Phase 1 — simulated annealing to a crossing-free embedding, restarted from the
// seed with fresh randomness until it finds one (crossings dominate the cost).
let best = null
for (let restart = 0; restart < SA_RESTARTS; restart++) {
  setSeed(1000 + restart * 7919)
  for (let i = 0; i < NODE_NAMES.length; i++) {
    X[i] = seedProjection.x[i]
    Y[i] = seedProjection.y[i]
  }
  for (let it = 0; it < SA_ITERS; it++) {
    const T = 90 * Math.pow(0.0002 / 90, it / SA_ITERS) // exp cool 90 → ~0
    const k = (rnd() * NODE_NAMES.length) | 0
    const ox = X[k]
    const oy = Y[k]
    const before = cost()
    X[k] += (rnd() - 0.5) * T * 2
    Y[k] += (rnd() - 0.5) * T * 2
    const after = cost()
    if (!(after <= before || rnd() < Math.exp((before - after) / (T + 1)))) {
      X[k] = ox
      Y[k] = oy
    }
  }
  const cr = crossings()
  const c = cost()
  if (!best || cr < best.cr || (cr === best.cr && c < best.c)) best = { cr, c, X: X.slice(), Y: Y.slice() }
  if (best.cr === 0) break
}
for (let i = 0; i < NODE_NAMES.length; i++) {
  X[i] = best.X[i]
  Y[i] = best.Y[i]
}

// Would moving node k leave any of its incident edges crossing another edge?
const moveBreaksPlanarity = (k) => {
  for (const ei of incident[k])
    for (let ej = 0; ej < edges.length; ej++)
      if (ej !== ei && segCross(edges[ei][0], edges[ei][1], edges[ej][0], edges[ej][1])) return true
  return false
}

// Phase 2 — planarity-preserving force relaxation. Apply spring + repulsion
// forces to even out spacing and shorten long edges, but reject any move that
// would re-introduce a crossing.
for (let pass = 0; pass < FDL_PASSES; pass++) {
  const damp = 0.9 * (1 - pass / FDL_PASSES) + 0.1
  for (let k = 0; k < NODE_NAMES.length; k++) {
    let fx = 0
    let fy = 0
    for (let j = 0; j < NODE_NAMES.length; j++) {
      if (j === k) continue
      const dx = X[k] - X[j]
      const dy = Y[k] - Y[j]
      const d2 = dx * dx + dy * dy || 0.01
      const d = Math.sqrt(d2)
      const f = 42000 / d2
      fx += (dx / d) * f
      fy += (dy / d) * f
    }
    for (const ei of incident[k]) {
      const other = edges[ei][0] === k ? edges[ei][1] : edges[ei][0]
      const dx = X[other] - X[k]
      const dy = Y[other] - Y[k]
      const d = Math.hypot(dx, dy) || 0.01
      const f = 0.05 * (d - REST_LEN)
      fx += (dx / d) * f
      fy += (dy / d) * f
    }
    const mag = Math.hypot(fx, fy) || 0.01
    const step = Math.min(mag, 30) * damp
    const ox = X[k]
    const oy = Y[k]
    X[k] += (fx / mag) * step
    Y[k] += (fy / mag) * step
    if (moveBreaksPlanarity(k)) {
      X[k] = ox
      Y[k] = oy
    }
  }
}

// Assemble into a name→position map for the finishing steps below.
const pos = {}
for (let i = 0; i < NODE_NAMES.length; i++) pos[NODE_NAMES[i]] = { x: X[i], y: Y[i] }

// Orient so the staging system sits at the bottom (largest screen y), matching
// the page's "staging anchors the bottom" convention.
const ys = NODE_NAMES.map((n) => pos[n].y)
const midY = (Math.min(...ys) + Math.max(...ys)) / 2
if (pos[STAGING].y < midY) {
  for (const n of NODE_NAMES) pos[n].y = 2 * midY - pos[n].y
}

// Fit to a padded integer viewBox and round positions.
const PAD = 100
const minX = Math.min(...NODE_NAMES.map((n) => pos[n].x))
const minY = Math.min(...NODE_NAMES.map((n) => pos[n].y))
for (const n of NODE_NAMES) {
  pos[n].x = Math.round(pos[n].x - minX + PAD)
  pos[n].y = Math.round(pos[n].y - minY + PAD)
}
const w = Math.round(Math.max(...NODE_NAMES.map((n) => pos[n].x)) + PAD)
const h = Math.round(Math.max(...NODE_NAMES.map((n) => pos[n].y)) + PAD)

// Report crossing count + closest pair (sanity check).
let closest = Infinity
let closestPair = ''
for (let i = 0; i < NODE_NAMES.length; i++) {
  for (let j = i + 1; j < NODE_NAMES.length; j++) {
    const d = Math.hypot(pos[NODE_NAMES[i]].x - pos[NODE_NAMES[j]].x, pos[NODE_NAMES[i]].y - pos[NODE_NAMES[j]].y)
    if (d < closest) {
      closest = d
      closestPair = `${NODE_NAMES[i]}–${NODE_NAMES[j]}`
    }
  }
}
console.error(`crossings: ${crossings()}`)

// Emit the NODE_POSITIONS block, ordered to match the current file's ordering.
const ORDER = [
  'JVA-FE',
  'RXA-W1',
  'X1-IZ0',
  '8P-LKL',
  'QFU-4S',
  'VK6-EZ',
  'QQGH-G',
  'L-WG68',
  'Q-UVY6',
  'G-VFVB',
  'VX1-HV',
  'HIK-MC',
  'GZM-KB',
  'KPI-OW',
  'K-XJJT',
  'JNG7-K',
  'FO1U-K',
  'Y4OK-W',
  '5LAJ-8',
  'E4-E8W',
  'P-NI4K',
  '8-SPNN',
  '6U-1RX',
  'B9EA-G',
  'E-BFLT',
  'GF-GR7',
  'HPMN-V',
  'Z19-B8',
  'DVN6-0',
  'XR-ZL7',
  'U1-VHY',
  '8OYE-Z',
  'XUPK-Z',
]
console.error(`closest pair: ${closestPair} at ${closest.toFixed(1)} (target ≥ ${MIN_SEP})`)
console.error(`viewBox: 0 0 ${w} ${h}`)
console.log('export const NODE_POSITIONS: Record<string, { x: number; y: number }> = {')
for (const n of ORDER) console.log(`  '${n}': { x: ${pos[n].x}, y: ${pos[n].y} },`)
console.log('}')
console.log(`// viewBox="0 0 ${w} ${h}"`)
