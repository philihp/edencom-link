'use client'

import { addIndex, map } from 'ramda'
import { useState, type ReactNode } from 'react'

import {
  arcPath,
  fills,
  formatShare,
  formatValue,
  labelPoint,
  slicesOf,
  total,
  type Datum,
  type Ring,
  type Slice,
  type Unit,
} from './arcs'
import styles from './charts.module.css'

// A donut chart in hand-written SVG. The ring shows the share of each slice,
// the centre shows the total, and the legend beside the ring names each slice
// with its value and share. Hover on a slice (or on its legend row) and the
// centre reads that slice. The geometry is in arcs.ts, which has tests.
//
// The SVG has a fixed coordinate space of SIZE×SIZE and stretches to the
// width that the layout gives it.

const SIZE = 200
const RING: Ring = { cx: SIZE / 2, cy: SIZE / 2, r: 96, inner: 62 }

type DonutProps = {
  data: readonly Datum[]
  // How many slices to show before the rest goes into "other".
  limit?: number
  unit?: Unit
  // The words under the total in the centre, e.g. "isk sold".
  caption?: string
  // The accessible name of the chart.
  title: string
}

const mapSlices = addIndex<Slice, ReactNode>(map)

export const Donut = ({ data, limit = 8, unit = 'isk', caption, title }: DonutProps) => {
  const [hover, setHover] = useState<number | null>(null)
  const slices = slicesOf(limit)(data)
  const colours = fills(slices)
  const whole = total(slices)
  const place = labelPoint(RING)
  const active = hover === null ? null : (slices[hover] ?? null)

  if (slices.length === 0) {
    return <p className={styles.empty}>nothing to show</p>
  }

  return (
    <div className={styles.donut}>
      <svg
        className={styles.ring}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
      >
        {mapSlices(
          (s, i) => (
            <path
              key={s.key}
              d={arcPath(RING, s.start, s.end)}
              fill={colours[i]}
              fillRule="evenodd"
              className={hover === null || hover === i ? styles.slice : `${styles.slice} ${styles.dim}`}
              onMouseEnter={() => setHover(i)}
            >
              <title>{`${s.label}: ${formatValue(unit, s.value)} (${formatShare(s.share)})`}</title>
            </path>
          ),
          slices
        )}
        {mapSlices((s, i) => {
          const at = place(s)
          return at === null ? null : (
            <text
              key={s.key}
              x={at.x}
              y={at.y}
              className={i === 0 && !s.other ? `${styles.sliceLabel} ${styles.onAccent}` : styles.sliceLabel}
              textAnchor="middle"
              dominantBaseline="central"
              pointerEvents="none"
            >
              {formatShare(s.share)}
            </text>
          )
        }, slices)}
        <text x={RING.cx} y={RING.cy - 6} className={styles.centreValue} textAnchor="middle">
          {formatValue(unit, active === null ? whole : active.value)}
        </text>
        <text x={RING.cx} y={RING.cy + 14} className={styles.centreCaption} textAnchor="middle">
          {active === null ? (caption ?? 'total') : active.label}
        </text>
      </svg>
      <ul className={styles.legend} onMouseLeave={() => setHover(null)}>
        {mapSlices(
          (s, i) => (
            <li
              key={s.key}
              className={hover === i ? `${styles.legendRow} ${styles.legendActive}` : styles.legendRow}
              onMouseEnter={() => setHover(i)}
            >
              <span className={styles.swatch} style={{ background: colours[i] }} aria-hidden />
              <span className={styles.legendLabel}>{s.other ? `${s.label} (${s.count})` : s.label}</span>
              <span className={styles.legendValue}>{formatValue(unit, s.value)}</span>
              <span className={styles.legendShare}>{formatShare(s.share)}</span>
            </li>
          ),
          slices
        )}
      </ul>
    </div>
  )
}
