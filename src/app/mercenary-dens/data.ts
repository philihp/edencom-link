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
  'VK6-EZ': ['JVA-FE', 'Q-UVY6', 'QQGH-G'],
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

// One row per temperate planet in the area. JVA-FE and 8P-LKL each have two
// temperate planets, so they appear twice. Ordered to follow the topology
// outward from staging.
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
]

// Fixed 2-D layout for the topology graph, in the SVG's own coordinate space
// (see topology.tsx's viewBox). Positions are hand-placed so the staging system
// sits at the top and links fan out without crossing.
export const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  'X1-IZ0': { x: 300, y: 40 },
  'RXA-W1': { x: 300, y: 120 },
  'JVA-FE': { x: 300, y: 200 },
  'QFU-4S': { x: 140, y: 290 },
  '8P-LKL': { x: 300, y: 300 },
  'VK6-EZ': { x: 470, y: 285 },
  'QQGH-G': { x: 285, y: 400 },
  'Q-UVY6': { x: 520, y: 385 },
}

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
