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
// (see topology.tsx's viewBox). X1-IZ0 anchors the bottom of the diagram,
// RXA-W1 directly above it, and JVA-FE directly above that; every other
// system blooms outward and upward from JVA-FE in a radial layout (BFS ring
// = distance from JVA-FE, angular slice sized by subtree weight — a branch
// with more systems past it gets more angular room), so the map reads like a
// flower with the staging spine as its stem. A few branch orderings are
// chosen deliberately (rather than left to the generic algorithm) so that
// systems on either end of a real cross-link — QQGH-G/VK6-EZ, and the
// Y4OK-W/6U-1RX loop through VX1-HV — land angularly adjacent instead of on
// opposite sides of the bloom.
export const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  'JVA-FE': { x: 560, y: 720 },
  'RXA-W1': { x: 560, y: 815 },
  'X1-IZ0': { x: 560, y: 910 },
  '8P-LKL': { x: 460, y: 803 },
  'QFU-4S': { x: 434, y: 688 },
  'VK6-EZ': { x: 665, y: 644 },
  'QQGH-G': { x: 359, y: 668 },
  'L-WG68': { x: 702, y: 568 },
  'Q-UVY6': { x: 720, y: 853 },
  'G-VFVB': { x: 288, y: 808 },
  'VX1-HV': { x: 301, y: 598 },
  'HIK-MC': { x: 713, y: 479 },
  'GZM-KB': { x: 832, y: 808 },
  'KPI-OW': { x: 780, y: 902 },
  'K-XJJT': { x: 197, y: 697 },
  'JNG7-K': { x: 231, y: 565 },
  'FO1U-K': { x: 311, y: 455 },
  'Y4OK-W': { x: 426, y: 382 },
  '5LAJ-8': { x: 755, y: 413 },
  'E4-E8W': { x: 923, y: 697 },
  'P-NI4K': { x: 119, y: 692 },
  '8-SPNN': { x: 160, y: 532 },
  '6U-1RX': { x: 257, y: 398 },
  'B9EA-G': { x: 797, y: 347 },
  'E-BFLT': { x: 1001, y: 692 },
  'GF-GR7': { x: 839, y: 281 },
  'HPMN-V': { x: 560, y: 122 },
  'Z19-B8': { x: 780, y: 164 },
  'DVN6-0': { x: 1044, y: 369 },
  'XR-ZL7': { x: 560, y: 44 },
  'U1-VHY': { x: 1023, y: 227 },
  '8OYE-Z': { x: 1172, y: 432 },
  'XUPK-Z': { x: 560, y: -34 },
}

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
