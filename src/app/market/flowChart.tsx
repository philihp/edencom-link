'use client'

import { useState } from 'react'

import { formatCompactIsk } from '../industry/lift'
import { formatIsk } from '../isk'
import { flowAxis, flowMoment, flowTick, xTickEdges, type FlowBucket } from './flow'
import type { Side } from './trade'
import styles from './market.module.css'

// The market flow chart: sales and purchases per bucket as two bars side by
// side, and the cumulative net ISK flow (sales minus purchases) as a line.
// Hand-written SVG, like the lift chart on /industry. The SVG keeps a fixed
// 1100×230 coordinate space and stretches to the width of its tile, so the
// geometry below is in those units.
//
// Colour: the series of the active tab wears the accent; the other series and
// the net line are grayscale. No status colour shows here.

const W = 1100
const H = 230
const PLOT_LEFT = 56
const PLOT_RIGHT = 1100
const PLOT_TOP = 8
const PLOT_BOTTOM = 196
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP
const X_TICKS = 6
// Part of each bucket's slot that the two bars fill together.
const BAR_FILL = 0.8

type FlowChartProps = {
  rows: FlowBucket[]
  bucketHours: number
  // The active tab: its series wears the accent.
  side: Side
}

export const FlowChart = ({ rows, bucketHours, side }: FlowChartProps) => {
  const [hover, setHover] = useState<number | null>(null)

  const n = Math.max(1, rows.length)
  const slot = PLOT_WIDTH / n
  const barW = (slot * BAR_FILL) / 2
  const axis = flowAxis(rows)
  const ty = (v: number) => PLOT_BOTTOM - (PLOT_HEIGHT * (v - axis.lo)) / (axis.hi - axis.lo)
  const zeroY = ty(0)
  const edgeX = (i: number) => PLOT_LEFT + i * slot

  // Bars stand on the zero line. A zero total draws no bar.
  const bar = (i: number, offset: number, v: number, className: string, key: string) =>
    v > 0 ? (
      <rect
        key={key}
        x={edgeX(i) + (slot * (1 - BAR_FILL)) / 2 + offset}
        y={ty(v)}
        width={barW}
        height={zeroY - ty(v)}
        className={className}
      />
    ) : null

  const salesClass = side === 'sell' ? styles.flowBarActive : styles.flowBarOther
  const purchasesClass = side === 'buy' ? styles.flowBarActive : styles.flowBarOther

  // The net line starts at zero at the window start and has one point at the
  // end of each bucket.
  const netPath = rows.reduce(
    (d, r, i) => `${d} L${edgeX(i + 1).toFixed(1)} ${ty(r.cumulative).toFixed(1)}`,
    `M${PLOT_LEFT} ${zeroY.toFixed(1)}`
  )

  // Where in the SVG's own units a pointer event landed, as a bucket index.
  const bucketAt = (e: { clientX: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    return x < PLOT_LEFT || x > PLOT_RIGHT ? null : Math.min(n - 1, Math.floor((x - PLOT_LEFT) / slot))
  }

  const hovered = hover == null ? null : rows[hover]
  const hoverFrac = hover == null ? 0 : (edgeX(hover) + slot / 2) / W

  return (
    <div className={styles.flowPlot}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.flowChart}
        role="img"
        aria-label="Sales and purchases per period, with the cumulative net ISK flow"
        onMouseMove={(e) => setHover(bucketAt(e))}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={PLOT_LEFT}
              x2={PLOT_RIGHT}
              y1={ty(t)}
              y2={ty(t)}
              className={t === 0 ? styles.flowZero : styles.flowGrid}
            />
            <text x={PLOT_LEFT - 6} y={ty(t) + 3.5} textAnchor="end" className={styles.flowAxisLabel}>
              {t === 0 ? '0' : formatCompactIsk(t)}
            </text>
          </g>
        ))}
        {xTickEdges(rows.length, X_TICKS).map((i) => (
          <g key={`x-${i}`}>
            <line x1={edgeX(i)} x2={edgeX(i)} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM + 6} className={styles.flowTick} />
            {i < rows.length && (
              <text x={edgeX(i)} y={PLOT_BOTTOM + 22} textAnchor="middle" className={styles.flowAxisLabel}>
                {flowTick(rows[i].start, bucketHours)}
              </text>
            )}
          </g>
        ))}
        {hover != null && (
          <rect x={edgeX(hover)} y={PLOT_TOP} width={slot} height={PLOT_HEIGHT} className={styles.flowHoverBand} />
        )}
        {rows.map((r, i) => [
          bar(i, 0, r.sales, salesClass, `s-${r.start}`),
          bar(i, barW, r.purchases, purchasesClass, `p-${r.start}`),
        ])}
        <path d={netPath} className={styles.flowNet} />
        {hovered != null && hover != null && (
          <circle cx={edgeX(hover + 1)} cy={ty(hovered.cumulative)} r={3.5} className={styles.flowNetDot} />
        )}
      </svg>
      {hovered != null && hover != null && (
        <div
          className={styles.flowCard}
          style={{
            left: `${(hoverFrac * 100).toFixed(2)}%`,
            transform: hoverFrac > 0.6 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)',
          }}
        >
          <div className={styles.flowCardMoment}>{flowMoment(hovered, bucketHours)}</div>
          <dl className={styles.flowCardRows}>
            <dt>
              <span className={`${styles.flowKey} ${salesClass}`} aria-hidden /> sales
            </dt>
            <dd title={formatIsk(hovered.sales)}>{formatCompactIsk(hovered.sales)}</dd>
            <dt>
              <span className={`${styles.flowKey} ${purchasesClass}`} aria-hidden /> purchases
            </dt>
            <dd title={formatIsk(hovered.purchases)}>{formatCompactIsk(hovered.purchases)}</dd>
            <dt>net</dt>
            <dd title={formatIsk(hovered.net)}>{formatCompactIsk(hovered.net)}</dd>
            <dt>
              <span className={`${styles.flowKey} ${styles.flowKeyLine}`} aria-hidden /> net to date
            </dt>
            <dd title={formatIsk(hovered.cumulative)}>{formatCompactIsk(hovered.cumulative)}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}

// The key above the chart: which mark is which series.
export const FlowLegend = ({ side }: { side: Side }) => (
  <span className={styles.flowLegend}>
    <span>
      <span className={`${styles.flowKey} ${side === 'sell' ? styles.flowBarActive : styles.flowBarOther}`} /> sales
    </span>
    <span>
      <span className={`${styles.flowKey} ${side === 'buy' ? styles.flowBarActive : styles.flowBarOther}`} /> purchases
    </span>
    <span>
      <span className={`${styles.flowKey} ${styles.flowKeyLine}`} /> net to date
    </span>
  </span>
)
