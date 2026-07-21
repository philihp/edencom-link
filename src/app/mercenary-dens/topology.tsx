import { EDGES, NODE_POSITIONS, NODE_VIEWBOX, STAGING, TEMPERATE_COUNTS } from './data'
import styles from './mercenaryDens.module.css'

export type NodeColor = 'red' | 'yellow' | 'green'

// Circle radius for each system node, in SVG user units. A system with
// temperate planets gets the larger circle to fit its row of globes on a
// second line.
const NODE_R = 24
const NODE_R_BADGE = 30

// One globe per temperate planet, all showing the same face of the earth for a
// given system — which face is a hash of the system name, so it's stable
// across renders but varies across the map.
const GLOBES = ['🌍', '🌎', '🌏']
const globeFor = (system: string) =>
  GLOBES[[...system].reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0x7fffffff, 0) % GLOBES.length]

const COLOR_CLASS: Record<NodeColor, string> = {
  red: styles.nodeRed,
  yellow: styles.nodeYellow,
  green: styles.nodeGreen,
}

// A network diagram of the systems reachable out from staging. Pure SVG with a
// fixed, crossing-free layout derived from real SDE geometry then untangled (see
// NODE_POSITIONS) — no interactivity — so it renders on the server and scales to
// the container width. Each system node is
// tinted by the most severe den status among its temperate planets (red
// reinforced > yellow external > green ours), matching the table below; a
// system with reported enemy-den intel also gets a dashed red outline
// (`enemyIntel`, upper-cased system names) on top of that tint.
export const Topology = ({
  nodeColors = {},
  enemyIntel,
}: {
  nodeColors?: Record<string, NodeColor>
  enemyIntel?: Set<string>
}) => (
  <svg
    className={styles.topology}
    viewBox={NODE_VIEWBOX}
    role="img"
    aria-label="Network topology of systems accessible from the staging system, coloured by mercenary den status; a dashed red outline marks a system with reported enemy-den intel"
  >
    {EDGES.map(([from, to]) => {
      const a = NODE_POSITIONS[from]
      const b = NODE_POSITIONS[to]
      if (!a || !b) return null
      return <line key={`${from}-${to}`} className={styles.edge} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
    })}

    {Object.entries(NODE_POSITIONS).map(([system, { x, y }]) => {
      const isStaging = system === STAGING
      const color = nodeColors[system]
      // A den-status colour wins; otherwise the staging system keeps its accent.
      // (styles.node is undefined — a plain node just gets the base .nodeBox —
      // so compose with a filter to avoid a stray "undefined" class.)
      const groupClass = color ? COLOR_CLASS[color] : isStaging ? styles.nodeStaging : styles.node
      // Enemy-den intel overlays a dashed red outline regardless of the tint.
      const className = [groupClass, enemyIntel?.has(system) ? styles.nodeEnemyIntel : null].filter(Boolean).join(' ')
      const temperate = TEMPERATE_COUNTS[system] ?? 0
      const r = temperate > 0 ? NODE_R_BADGE : NODE_R
      return (
        <g key={system} className={className}>
          <circle cx={x} cy={y} r={r} className={styles.nodeBox} />
          <text
            x={x}
            y={temperate > 0 ? y - 8 : y}
            className={styles.nodeLabel}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {system}
          </text>
          {temperate > 0 ? (
            <text x={x} y={y + 10} className={styles.nodeCount} textAnchor="middle" dominantBaseline="central">
              {globeFor(system).repeat(temperate)}
            </text>
          ) : null}
        </g>
      )
    })}
  </svg>
)
