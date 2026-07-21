// Generator for the Mercenary Dens topology layout (src/app/mercenary-dens/data.ts's
// NODE_POSITIONS). The map is a fixed, hand-maintained set of systems, so rather
// than hand-place each node we derive the layout from CCP's real universe geometry:
//
//   1. Start from each system's true 3-D position in the SDE (position.x/y/z, in
//      metres), projected onto the EVE galaxy-map plane (x, z) — the same top-down
//      plane the in-game star map uses (y is galactic "up" and is dropped).
//   2. Relax with a force-directed pass — pairwise repulsion so crowded systems
//      stop overlapping, edge springs so linked systems stay a readable distance
//      apart, and a weak anchor back to the true projected position so the map
//      keeps its real geography instead of drifting into a generic graph blob.
//
// The raw SDE coordinates are embedded below (build 3439610, mapSolarSystems.jsonl)
// so this script reproduces the layout deterministically with no network. When the
// system list changes, add the new system's coordinates here (from the SDE mirror)
// and re-run: `node scripts/mercenaryDenLayout.mjs` prints the NODE_POSITIONS block
// to paste into data.ts.

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
const REST_LEN = 120 // ideal drawn distance along a link
const MIN_SEP = 92 // desired minimum centre-to-centre spacing (node badge Ø ≈ 60)
const K_REP = 44000 // pairwise repulsion strength
const K_SPRING = 0.06 // edge spring stiffness
const K_ANCHOR = 0.015 // pull back toward the true SDE position (keeps geography)
const ITERATIONS = 4000
const T0 = 40 // initial max step (cools linearly to 0)

// Distinct undirected edges.
const edges = (() => {
  const seen = new Set()
  const out = []
  for (const [from, tos] of Object.entries(LINKS)) {
    for (const to of tos) {
      const k = [from, to].sort().join('|')
      if (seen.has(k)) continue
      seen.add(k)
      out.push([from, to])
    }
  }
  return out
})()

// Project true 3-D position onto the map plane (x, z), then normalise to a
// working box so the force constants above are in "screen" units.
const projected = (() => {
  const px = NODE_NAMES.map((n) => SDE[n].x)
  const pz = NODE_NAMES.map((n) => SDE[n].z)
  const minX = Math.min(...px)
  const maxX = Math.max(...px)
  const minZ = Math.min(...pz)
  const maxZ = Math.max(...pz)
  const span = Math.max(maxX - minX, maxZ - minZ)
  const scale = 900 / span
  const out = {}
  for (const n of NODE_NAMES) {
    out[n] = {
      // screen y = z (flipped later if needed so staging sits at the bottom)
      x: (SDE[n].x - minX) * scale,
      y: (SDE[n].z - minZ) * scale,
    }
  }
  return out
})()

// Simulate.
const pos = {}
for (const n of NODE_NAMES) pos[n] = { x: projected[n].x, y: projected[n].y }

for (let iter = 0; iter < ITERATIONS; iter++) {
  const temp = T0 * (1 - iter / ITERATIONS)
  const disp = {}
  for (const n of NODE_NAMES) disp[n] = { x: 0, y: 0 }

  // Repulsion between every pair.
  for (let i = 0; i < NODE_NAMES.length; i++) {
    for (let j = i + 1; j < NODE_NAMES.length; j++) {
      const a = NODE_NAMES[i]
      const b = NODE_NAMES[j]
      let dx = pos[a].x - pos[b].x
      let dy = pos[a].y - pos[b].y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        // Coincident: nudge deterministically so they separate.
        dx = (i - j) * 0.01 + 0.1
        dy = 0.1
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      const f = K_REP / d2
      const ux = dx / d
      const uy = dy / d
      disp[a].x += ux * f
      disp[a].y += uy * f
      disp[b].x -= ux * f
      disp[b].y -= uy * f
    }
  }

  // Spring attraction along links.
  for (const [a, b] of edges) {
    const dx = pos[b].x - pos[a].x
    const dy = pos[b].y - pos[a].y
    const d = Math.hypot(dx, dy) || 0.001
    const f = K_SPRING * (d - REST_LEN)
    const ux = dx / d
    const uy = dy / d
    disp[a].x += ux * f
    disp[a].y += uy * f
    disp[b].x -= ux * f
    disp[b].y -= uy * f
  }

  // Weak anchor back to the true projected position — this is what keeps the
  // layout faithful to the real star geography rather than a generic blob.
  for (const n of NODE_NAMES) {
    disp[n].x += (projected[n].x - pos[n].x) * K_ANCHOR
    disp[n].y += (projected[n].y - pos[n].y) * K_ANCHOR
  }

  // Apply, capped by the cooling temperature.
  for (const n of NODE_NAMES) {
    const d = Math.hypot(disp[n].x, disp[n].y) || 0.001
    const step = Math.min(d, temp)
    pos[n].x += (disp[n].x / d) * step
    pos[n].y += (disp[n].y / d) * step
  }
}

// Orient so the staging system sits at the bottom (largest screen y), matching
// the page's "staging anchors the bottom" convention.
const ys = NODE_NAMES.map((n) => pos[n].y)
const midY = (Math.min(...ys) + Math.max(...ys)) / 2
if (pos[STAGING].y < midY) {
  for (const n of NODE_NAMES) pos[n].y = 2 * midY - pos[n].y
}

// Fit to a padded integer viewBox and round positions.
const PAD = 100
const xs = NODE_NAMES.map((n) => pos[n].x)
const yy = NODE_NAMES.map((n) => pos[n].y)
const minX = Math.min(...xs)
const minY = Math.min(...yy)
for (const n of NODE_NAMES) {
  pos[n].x = Math.round(pos[n].x - minX + PAD)
  pos[n].y = Math.round(pos[n].y - minY + PAD)
}
const w = Math.round(Math.max(...NODE_NAMES.map((n) => pos[n].x)) + PAD)
const h = Math.round(Math.max(...NODE_NAMES.map((n) => pos[n].y)) + PAD)

// Report closest pair (sanity check on overlaps).
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
