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
// (see topology.tsx's viewBox). Positions are hand-placed so links fan out
// without crossing; the staging system anchors the bottom-left corner, its
// lone link running up the empty left edge to RXA-W1.
export const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  'X1-IZ0': { x: 80, y: 700 },
  'RXA-W1': { x: 80, y: 200 },
  'JVA-FE': { x: 300, y: 200 },
  'QFU-4S': { x: 140, y: 290 },
  '8P-LKL': { x: 300, y: 300 },
  'VK6-EZ': { x: 470, y: 285 },
  'QQGH-G': { x: 285, y: 400 },
  'Q-UVY6': { x: 520, y: 385 },
  'L-WG68': { x: 600, y: 245 },
  'HIK-MC': { x: 700, y: 185 },
  'GZM-KB': { x: 560, y: 330 },
  // HIK-MC's fan: the E4-E8W/5LAJ-8 pair feeds the B9EA-G→GF-GR7 cluster in
  // the middle, while Y4OK-W starts the long loop down the right edge and along
  // the bottom (6U-1RX → FO1U-K → VX1-HV) back to QQGH-G.
  'E4-E8W': { x: 650, y: 290 },
  '5LAJ-8': { x: 750, y: 315 },
  'E-BFLT': { x: 600, y: 390 },
  'B9EA-G': { x: 720, y: 390 },
  'GF-GR7': { x: 720, y: 460 },
  'HPMN-V': { x: 620, y: 510 },
  'Z19-B8': { x: 720, y: 530 },
  'DVN6-0': { x: 850, y: 490 },
  'U1-VHY': { x: 840, y: 560 },
  '8OYE-Z': { x: 930, y: 590 },
  'XR-ZL7': { x: 660, y: 580 },
  'XUPK-Z': { x: 760, y: 610 },
  'Y4OK-W': { x: 1020, y: 120 },
  '6U-1RX': { x: 1020, y: 680 },
  'FO1U-K': { x: 560, y: 640 },
  'VX1-HV': { x: 350, y: 520 },
  'K-XJJT': { x: 200, y: 580 },
  'P-NI4K': { x: 140, y: 660 },
  'JNG7-K': { x: 390, y: 620 },
  '8-SPNN': { x: 420, y: 700 },
  'G-VFVB': { x: 180, y: 450 },
  'KPI-OW': { x: 560, y: 460 },
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
