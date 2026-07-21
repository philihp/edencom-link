// Static map data for the dark-launched Mercenary Dens page.
//
// There is no ESI feed (nor DB extract) for mercenary-den ownership, reinforced
// state, or which planets are temperate for arbitrary systems, so this file is
// hand-maintained. The system links and temperate-planet numbers below were
// taken from CCP's live universe data (ESI `/universe/systems` +
// `/universe/planets`, planet type_id 11 = Temperate) and are stable game-map
// facts. The den ownership fields are the volatile part: edit `den` on a planet
// as intel changes.

// Our staging system — the root that RXA-W1 is immediately accessible from.
export const STAGING = 'X1-IZ0'

// Undirected adjacency of the systems reachable out from staging. Listing an
// edge once (A -> [B]) is enough; the topology treats links as bidirectional.
export const LINKS: Record<string, string[]> = {
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

// The current owner of a mercenary den on a temperate planet. `null` den means
// no den is deployed (or none known). When a den exists, `alliance` is the
// alliance ticker/name of the owning character's alliance (null if unknown or
// unaffiliated), and `reinforced` flags a den currently in its reinforcement
// timer.
export type Den = {
  owner: string
  alliance: string | null
  reinforced: boolean
}

export type TemperatePlanet = {
  system: string
  // Roman-numeral position of the temperate planet within its system, e.g.
  // 'III' for the third planet (RXA-W1 III).
  planet: string
  den: Den | null
}

// One row per temperate planet in the area. A system with several temperate
// planets appears once per planet (6U-1RX has three, XR-ZL7 four). Ordered to
// follow the topology outward from staging. HIK-MC, E4-E8W, FO1U-K, P-NI4K,
// G-VFVB, KPI-OW, E-BFLT, GF-GR7, Z19-B8, and 8OYE-Z have no temperate planet,
// so they appear on the map but not here.
export const TEMPERATE_PLANETS: TemperatePlanet[] = [
  { system: 'RXA-W1', planet: 'III', den: null },
  { system: 'JVA-FE', planet: 'II', den: null },
  { system: 'JVA-FE', planet: 'VI', den: null },
  { system: 'QFU-4S', planet: 'III', den: null },
  { system: '8P-LKL', planet: 'III', den: null },
  { system: '8P-LKL', planet: 'VI', den: null },
  { system: 'VK6-EZ', planet: 'IV', den: null },
  { system: 'QQGH-G', planet: 'V', den: null },
  { system: 'Q-UVY6', planet: 'II', den: null },
  { system: 'GZM-KB', planet: 'IV', den: null },
  { system: 'GZM-KB', planet: 'V', den: null },
  { system: 'VX1-HV', planet: 'II', den: null },
  { system: 'VX1-HV', planet: 'III', den: null },
  { system: 'K-XJJT', planet: 'III', den: null },
  { system: 'JNG7-K', planet: 'V', den: null },
  { system: '8-SPNN', planet: 'VI', den: null },
  { system: '6U-1RX', planet: 'IV', den: null },
  { system: '6U-1RX', planet: 'IX', den: null },
  { system: '6U-1RX', planet: 'X', den: null },
  { system: 'Y4OK-W', planet: 'II', den: null },
  { system: '5LAJ-8', planet: 'VI', den: null },
  { system: 'B9EA-G', planet: 'VIII', den: null },
  { system: 'HPMN-V', planet: 'III', den: null },
  { system: 'HPMN-V', planet: 'V', den: null },
  { system: 'DVN6-0', planet: 'II', den: null },
  { system: 'DVN6-0', planet: 'III', den: null },
  { system: 'U1-VHY', planet: 'III', den: null },
  { system: 'U1-VHY', planet: 'V', den: null },
  { system: 'XR-ZL7', planet: 'III', den: null },
  { system: 'XR-ZL7', planet: 'V', den: null },
  { system: 'XR-ZL7', planet: 'VII', den: null },
  { system: 'XR-ZL7', planet: 'VIII', den: null },
  { system: 'XUPK-Z', planet: 'VII', den: null },
]

// Fixed 2-D layout for the topology graph, in the SVG's own coordinate space
// (see topology.tsx's viewBox — kept in sync with NODE_VIEWBOX below). Rather
// than hand-place each node, this is derived from CCP's real universe geometry
// and then untangled into a clean, crossing-free drawing:
//
//   1. Seed from each system's true 3-D position in the SDE (position.x/y/z),
//      projected onto the EVE galaxy-map plane (x, z) — the same top-down plane
//      the in-game star map uses (y is galactic "up" and is dropped).
//   2. Simulated annealing to a planar (zero edge-crossing) embedding, then a
//      planarity-preserving force relaxation to even out spacing and shorten
//      long edges without ever re-introducing a crossing.
//
// So no two links cross, while the layout still broadly follows real geography
// (the annealer starts from the SDE projection). Because the system list is a
// fixed, hand-maintained set, the positions are baked here rather than recomputed
// at request time. The generator lives at scripts/mercenaryDenLayout.mjs (raw SDE
// coordinates embedded, seeded PRNG, deterministic, no network) — when a system
// is added to/removed from LINKS, add its SDE coordinates there and re-run it to
// regenerate this block and NODE_VIEWBOX.
export const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  'JVA-FE': { x: 372, y: 1262 },
  'RXA-W1': { x: 209, y: 1421 },
  'X1-IZ0': { x: 100, y: 1586 },
  '8P-LKL': { x: 519, y: 1395 },
  'QFU-4S': { x: 540, y: 1239 },
  'VK6-EZ': { x: 521, y: 1055 },
  'QQGH-G': { x: 705, y: 1293 },
  'L-WG68': { x: 630, y: 777 },
  'Q-UVY6': { x: 307, y: 958 },
  'G-VFVB': { x: 727, y: 1498 },
  'VX1-HV': { x: 980, y: 1381 },
  'HIK-MC': { x: 852, y: 597 },
  'GZM-KB': { x: 493, y: 623 },
  'KPI-OW': { x: 118, y: 883 },
  'K-XJJT': { x: 1069, y: 1595 },
  'JNG7-K': { x: 1212, y: 1405 },
  'FO1U-K': { x: 1030, y: 1177 },
  'Y4OK-W': { x: 922, y: 787 },
  '5LAJ-8': { x: 982, y: 392 },
  'E4-E8W': { x: 1064, y: 518 },
  'P-NI4K': { x: 1174, y: 1767 },
  '8-SPNN': { x: 1412, y: 1436 },
  '6U-1RX': { x: 1003, y: 975 },
  'B9EA-G': { x: 1220, y: 372 },
  'E-BFLT': { x: 1214, y: 625 },
  'GF-GR7': { x: 1494, y: 357 },
  'HPMN-V': { x: 1597, y: 164 },
  'Z19-B8': { x: 1694, y: 300 },
  'DVN6-0': { x: 1635, y: 553 },
  'XR-ZL7': { x: 1800, y: 142 },
  'U1-VHY': { x: 1639, y: 751 },
  '8OYE-Z': { x: 1823, y: 634 },
  'XUPK-Z': { x: 1993, y: 100 },
}

// SVG viewBox that frames NODE_POSITIONS with padding — regenerated alongside
// the positions above by scripts/mercenaryDenLayout.mjs.
export const NODE_VIEWBOX = '0 0 2093 1867'

// Temperate-planet count per system, shown as the 🌍 badge under each node's
// name on the topology. Derived from TEMPERATE_PLANETS so the badge can never
// drift from the table.
export const TEMPERATE_COUNTS: Record<string, number> = (() => {
  const counts: Record<string, number> = {}
  TEMPERATE_PLANETS.forEach(({ system }) => {
    counts[system] = (counts[system] ?? 0) + 1
  })
  return counts
})()

// Distinct undirected edges derived from LINKS (each pair once), for drawing.
export const EDGES: [string, string][] = (() => {
  const seen = new Set<string>()
  const edges: [string, string][] = []
  Object.entries(LINKS).forEach(([from, tos]) => {
    tos.forEach((to) => {
      const key = [from, to].sort().join('|')
      if (seen.has(key)) return
      seen.add(key)
      edges.push([from, to])
    })
  })
  return edges
})()
