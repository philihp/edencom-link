import { NODE_R, NODE_R_BADGE, PX_PER_UNIT, type Point } from './graph'
import styles from './mercenaryDens.module.css'

export type NodeColor = 'red' | 'yellow' | 'green'

export type TopologyNode = Point & {
  systemID: number
  name: string
  // Temperate planets in the system — one globe each, the planets a mercenary
  // den can sit on.
  temperate: number
  color: NodeColor | null
  enemyIntel: boolean
}

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

// A network diagram of the systems the account's dens sit in and everything one
// stargate away. Pure SVG — no interactivity — so it renders on the server.
// Nodes, links and coordinates all come from the mirrored SDE (see graph.ts and
// page.tsx); nothing about the map is hand-maintained. It is drawn at a fixed
// density (PX_PER_UNIT) and its container scrolls, so a long run of systems
// stays readable instead of shrinking to specks.
//
// A node is tinted by the most severe den status among its temperate planets
// (red reinforced > green ours), matching the table below, or yellow where a
// sighting names a system we hold no den in; a sighted system also takes a
// dashed red outline on top of whatever tint it has.
export const Topology = ({
  nodes,
  edges,
  viewBox,
  width,
  height,
}: {
  nodes: TopologyNode[]
  edges: [number, number][]
  viewBox: string
  width: number
  height: number
}) => {
  if (nodes.length === 0) return null
  const pointOf = new Map(nodes.map((node) => [node.systemID, node]))
  return (
    <div className={styles.topologyScroll}>
      <svg
        className={styles.topology}
        viewBox={viewBox}
        width={Math.round(width * PX_PER_UNIT)}
        height={Math.round(height * PX_PER_UNIT)}
        role="img"
        aria-label="Network topology of the systems holding the mercenary dens you can see, coloured by den status; a dashed red outline marks a system with reported enemy-den intel"
      >
        {edges.map(([from, to]) => {
          const a = pointOf.get(from)
          const b = pointOf.get(to)
          if (!a || !b) return null
          return <line key={`${from}-${to}`} className={styles.edge} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        })}

        {nodes.map(({ systemID, name, x, y, temperate, color, enemyIntel }) => {
          // (styles.node is undefined — a plain node just gets the base .nodeBox —
          // so compose with a filter to avoid a stray "undefined" class.)
          const className = [color ? COLOR_CLASS[color] : styles.node, enemyIntel ? styles.nodeEnemyIntel : null]
            .filter(Boolean)
            .join(' ')
          return (
            <g key={systemID} className={className}>
              <circle cx={x} cy={y} r={temperate > 0 ? NODE_R_BADGE : NODE_R} className={styles.nodeBox} />
              <text
                x={x}
                y={temperate > 0 ? y - 16 : y}
                className={styles.nodeLabel}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {name}
              </text>
              {temperate > 0 ? (
                <text x={x} y={y + 20} className={styles.nodeCount} textAnchor="middle" dominantBaseline="central">
                  {globeFor(name).repeat(temperate)}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
