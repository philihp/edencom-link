'use client'

import { useEffect, useRef } from 'react'

import { formatMoment, formatTick } from './chartTime'
import styles from './industry.module.css'
import { formatCompactIsk, niceCeiling, rateSegments, runningAt, type LiftJob, type LiftScope } from './lift'

// The lift-rate chart: a step function of the hangar's summed ISK/hr over the
// window [t0, t1], drawn as steps because that is what the data is. Hover
// reads the moment; scroll zooms about the cursor and shift-scroll (or a
// trackpad's sideways swipe) pans; a click pins the moment as the list's
// scope. The SVG keeps a fixed 1100×230 coordinate space and stretches to its
// container at that aspect ratio (so a phone gets a shorter chart rather than
// a tiny drawing in a tall box), so the geometry below is in those units.

const W = 1100
const H = 230
const PLOT_LEFT = 52
const PLOT_RIGHT = 1100
const PLOT_TOP = 8
const BASELINE = 196
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT
const PLOT_HEIGHT = BASELINE - PLOT_TOP

const DAY = 86_400_000
const HOUR = 3_600_000
// The window can never be narrower than this, so a wheel spun to the stop
// still shows a readable stretch of time.
const MIN_SPAN = 6 * HOUR
const X_TICKS = 7
const Y_TICKS = 4
// Past this width a day label would overlap its neighbour.
const MONTHLY_PAST = 150 * DAY
// The hover card lists this many of the running jobs, then "+ n more".
const CARD_JOBS = 5

type LiftChartProps = {
  // Already owner-filtered by the view.
  jobs: readonly LiftJob[]
  scope: LiftScope
  t0: number
  t1: number
  // Floor and ceiling for panning and zooming: the oldest job on record and a
  // fortnight past now.
  minT: number
  maxT: number
  // The present: a vertical rule, so the projected stretch past it reads as
  // the future it is.
  now: number
  hoverT: number | null
  scopeT: number | null
  typeNames: Readonly<Record<number, string>>
  onRange: (t0: number, t1: number) => void
  onHover: (t: number | null) => void
  onScope: (t: number) => void
}

export const LiftChart = ({
  jobs,
  scope,
  t0,
  t1,
  minT,
  maxT,
  now,
  hoverT,
  scopeT,
  typeNames,
  onRange,
  onHover,
  onScope,
}: LiftChartProps) => {
  const svgRef = useRef<SVGSVGElement>(null)

  const span = t1 - t0
  const tx = (t: number) => PLOT_LEFT + (PLOT_WIDTH * (t - t0)) / span
  const xt = (x: number) => t0 + ((x - PLOT_LEFT) / PLOT_WIDTH) * span

  // Where in the SVG's own units a pointer event landed.
  const svgX = (e: { clientX: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect()
    return ((e.clientX - r.left) / r.width) * W
  }

  // React registers wheel listeners passively, so preventDefault() inside
  // onWheel cannot stop the page scrolling under the chart. A listener added
  // by hand with { passive: false } can — the same chart-in-a-page problem
  // every zoomable map solves this way.
  const latest = useRef({ t0, t1, minT, maxT, onRange })
  latest.current = { t0, t1, minT, maxT, onRange }
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { t0, t1, minT, maxT, onRange } = latest.current
      const span = t1 - t0
      const r = svg.getBoundingClientRect()
      const x = Math.min(PLOT_RIGHT, Math.max(PLOT_LEFT, ((e.clientX - r.left) / r.width) * W))
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Pan, by the wheel's own distance scaled to the window.
        const dx = (((e.deltaX || e.deltaY) * span) / PLOT_WIDTH) * 1.2
        let a = t0 + dx
        let b = t1 + dx
        if (a < minT) {
          b += minT - a
          a = minT
        }
        if (b > maxT) {
          a -= b - maxT
          b = maxT
        }
        onRange(a, b)
        return
      }
      // Zoom about the cursor: the moment under it stays put.
      const f = Math.exp(e.deltaY * 0.0015)
      const c = t0 + ((x - PLOT_LEFT) / PLOT_WIDTH) * span
      const a = Math.max(minT, c - (c - t0) * f)
      const b = Math.min(maxT, c + (t1 - c) * f)
      if (b - a < MIN_SPAN) return
      onRange(a, b)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const segments = rateSegments(jobs, t0, t1, scope)
  const peak = segments.reduce((m, s) => Math.max(m, s.v), 0)
  const yMax = niceCeiling(peak)
  const ty = (v: number) => BASELINE - (PLOT_HEIGHT * Math.max(0, v)) / yMax

  // The step path: a horizontal run per segment, a vertical riser between
  // them. The area under it closes to the baseline for the faint fill.
  let line = ''
  let area = `M${PLOT_LEFT} ${BASELINE}`
  segments.forEach((s, i) => {
    const xa = tx(s.a).toFixed(1)
    const xb = tx(s.b).toFixed(1)
    const y = ty(s.v).toFixed(1)
    line += (i === 0 ? `M${xa} ${y}` : ` V${y}`) + ` H${xb}`
    area += ` L${xa} ${y} L${xb} ${y}`
  })
  area += ` L${PLOT_RIGHT} ${BASELINE} Z`

  const yTicks = Array.from({ length: Y_TICKS }, (_, i) => {
    const v = (yMax * (i + 1)) / Y_TICKS
    return { y: ty(v), label: formatCompactIsk(v) }
  })
  const monthly = span > MONTHLY_PAST
  const xTicks = Array.from({ length: X_TICKS + 1 }, (_, i) => {
    const t = t0 + (span * i) / X_TICKS
    return { x: tx(t), label: formatTick(t, monthly) }
  })

  const hasHover = hoverT != null && hoverT >= t0 && hoverT <= t1
  const hoverJobs = hasHover ? runningAt(jobs, hoverT, scope) : []
  const hoverRate = hoverJobs.reduce((sum, j) => sum + (j.rate ?? 0), 0)
  const hoverX = hasHover ? tx(hoverT) : 0
  const hoverFrac = (hoverX - PLOT_LEFT) / PLOT_WIDTH
  const hasScope = scopeT != null && scopeT >= t0 && scopeT <= t1
  const hasNow = now >= t0 && now <= t1

  const productName = (j: LiftJob) => {
    const id = j.productTypeId ?? j.blueprintTypeId
    return typeNames[id] ?? `#${id}`
  }

  return (
    <div className={styles.plot}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={styles.chart}
        role="img"
        aria-label="Lift rate over time"
        onMouseMove={(e) => {
          const x = svgX(e)
          if (x < PLOT_LEFT || x > PLOT_RIGHT) return
          onHover(xt(x))
        }}
        onMouseLeave={() => onHover(null)}
        onClick={(e) => {
          const x = svgX(e)
          if (x < PLOT_LEFT) return
          onScope(xt(x))
        }}
      >
        {yTicks.map((t) => (
          <g key={`y-${t.label}`}>
            <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={t.y} y2={t.y} className={styles.gridLine} />
            <text x={PLOT_LEFT - 6} y={t.y + 3.5} textAnchor="end" className={styles.axisLabel}>
              {t.label}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <g key={`x-${i}`}>
            <line x1={t.x} x2={t.x} y1={BASELINE} y2={BASELINE + 6} className={styles.axisTick} />
            <text x={t.x} y={BASELINE + 22} textAnchor="middle" className={styles.axisLabel}>
              {t.label}
            </text>
          </g>
        ))}
        <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={BASELINE} y2={BASELINE} className={styles.axisTick} />
        <path d={area} className={styles.area} />
        <path d={line} className={styles.line} />
        {hasNow && (
          <g>
            <line x1={tx(now)} x2={tx(now)} y1={PLOT_TOP} y2={BASELINE} className={styles.nowLine} />
            <text x={tx(now) + 4} y={PLOT_TOP + 9} className={styles.nowLabel}>
              now
            </text>
          </g>
        )}
        {hasScope && (
          <g>
            <line x1={tx(scopeT)} x2={tx(scopeT)} y1={PLOT_TOP} y2={BASELINE} className={styles.scopeLine} />
            <rect x={tx(scopeT) - 20} y={-4} width={40} height={13} rx={2} className={styles.scopeBadge} />
            <text x={tx(scopeT)} y={6} textAnchor="middle" className={styles.scopeLabel}>
              scoped
            </text>
          </g>
        )}
        {hasHover && (
          <g>
            <line x1={hoverX} x2={hoverX} y1={PLOT_TOP} y2={BASELINE} className={styles.hoverLine} />
            <circle cx={hoverX} cy={ty(hoverRate)} r={3.5} className={styles.hoverDot} />
          </g>
        )}
        <rect x={PLOT_LEFT} y={0} width={PLOT_WIDTH} height={BASELINE} fill="transparent" />
      </svg>
      {hasHover && (
        <div
          className={styles.card}
          style={{
            left: `calc(14px + (100% - 28px) * ${(hoverX / W).toFixed(4)})`,
            transform: hoverFrac > 0.68 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)',
          }}
        >
          <div className={styles.cardHead}>
            <span className={styles.cardMoment}>{formatMoment(hoverT)}</span>
            <span>
              <span className={styles.cardRate}>{formatCompactIsk(hoverRate)}</span>{' '}
              <span className={styles.cardUnit}>ISK/hr</span>
            </span>
          </div>
          <div className={styles.cardJobs}>
            {hoverJobs.slice(0, CARD_JOBS).map((j) => (
              <div key={j.id} className={styles.cardJob}>
                <span className={styles.cardProduct}>
                  <span className={styles.cardFamily}>{j.family === 'manufacturing' ? 'mfg' : 'rxn'}</span>{' '}
                  {productName(j)}
                </span>
                <span className={styles.cardJobRate}>{formatCompactIsk(j.rate)}/hr</span>
              </div>
            ))}
            {hoverJobs.length > CARD_JOBS && (
              <div className={styles.cardMore}>+ {hoverJobs.length - CARD_JOBS} more</div>
            )}
          </div>
          <div className={styles.cardFoot}>
            <span className={styles.mono}>{hoverJobs.length}</span> jobs running · click to scope the list to this
            moment
          </div>
        </div>
      )}
    </div>
  )
}
