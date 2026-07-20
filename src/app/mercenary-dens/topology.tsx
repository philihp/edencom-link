import { EDGES, NODE_POSITIONS, STAGING } from './data'
import styles from './mercenaryDens.module.css'

export type NodeColor = 'red' | 'yellow' | 'green'

// Pill dimensions for each system node, in SVG user units.
const NODE_W = 66
const NODE_H = 24

const COLOR_CLASS: Record<NodeColor, string> = {
  red: styles.nodeRed,
  yellow: styles.nodeYellow,
  green: styles.nodeGreen,
}

// A network diagram of the systems reachable out from staging. Pure SVG with a
// fixed hand-placed layout (see NODE_POSITIONS) — no interactivity — so it
// renders on the server and scales to the container width. Each system node is
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
    viewBox="0 0 760 450"
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
      return (
        <g key={system} className={className}>
          <rect
            x={x - NODE_W / 2}
            y={y - NODE_H / 2}
            width={NODE_W}
            height={NODE_H}
            rx={6}
            className={styles.nodeBox}
          />
          <text x={x} y={y} className={styles.nodeLabel} textAnchor="middle" dominantBaseline="central">
            {system}
          </text>
        </g>
      )
    })}
  </svg>
)
