'use client'

import { formatTick } from '../industry/chartTime'
import chart from '../industry/industry.module.css'
import { formatCompactIsk } from '../industry/lift'
import { formatIsk } from '../isk'
import { xTickEdges } from '../market/flow'
import { PART_LABEL, VALUE_PARTS, valueAxis, type ValuePoint } from './valuation'

// The valuation chart: the hangar's total worth, one point per UTC day, as a
// line over a faint area — the lift chart's marks and classes (industry
// .module.css), so the three charts read as one family. Hover reads a day and
// what it is made of and the owners that hold it. The SVG keeps the same fixed 1100×230
// coordinate space as the lift and flow charts and stretches to its tile.

const W = 1100
const H = 230
const PLOT_LEFT = 56
const PLOT_RIGHT = 1092
const PLOT_TOP = 8
const BASELINE = 196
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT
const PLOT_HEIGHT = BASELINE - PLOT_TOP
const X_TICKS = 7
// The hover card names this many owners, then "+ n more".
const CARD_OWNERS = 5

type ValueChartProps = {
  points: readonly ValuePoint[]
  ownerName: (ownerId: string) => string
  hover: number | null
  onHover: (index: number | null) => void
  // Label the x axis by month ("Nov 2026") rather than by day.
  monthly?: boolean
}

export const ValueChart = ({ points, ownerName, hover, onHover, monthly = false }: ValueChartProps) => {
  const n = points.length
  const axis = valueAxis(points)
  // One point per day, at the day's centre slot; a single day sits mid-plot.
  const tx = (i: number) => (n <= 1 ? PLOT_LEFT + PLOT_WIDTH / 2 : PLOT_LEFT + (PLOT_WIDTH * i) / (n - 1))
  const ty = (v: number) => BASELINE - (PLOT_HEIGHT * (v - axis.lo)) / (axis.hi - axis.lo)

  // Runs of consecutive known days: a day nobody has a value for breaks the
  // line rather than diving to the floor.
  const runs = points.reduce<number[][]>((acc, p, i) => {
    if (p.total == null) return acc
    const last = acc.at(-1)
    if (last && last.at(-1) === i - 1) last.push(i)
    else acc.push([i])
    return acc
  }, [])
  const linePath = runs
    .map((run) =>
      run
        .map((i, k) => `${k === 0 ? 'M' : 'L'}${tx(i).toFixed(1)} ${ty(points[i].total as number).toFixed(1)}`)
        .join(' ')
    )
    .join(' ')
  const areaPath = runs
    .map(
      (run) =>
        `M${tx(run[0]).toFixed(1)} ${BASELINE} ` +
        run.map((i) => `L${tx(i).toFixed(1)} ${ty(points[i].total as number).toFixed(1)}`).join(' ') +
        ` L${tx(run.at(-1) as number).toFixed(1)} ${BASELINE} Z`
    )
    .join(' ')

  const indexAt = (e: { clientX: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    if (x < PLOT_LEFT - 8 || x > PLOT_RIGHT + 8 || n === 0) return null
    return n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((x - PLOT_LEFT) / PLOT_WIDTH) * (n - 1))))
  }

  const hovered = hover == null ? null : points[hover]
  const hoverX = hover == null ? 0 : tx(hover)
  const hoverFrac = (hoverX - PLOT_LEFT) / PLOT_WIDTH
  const previous = hover == null ? null : points.slice(0, hover).findLast((p) => p.total != null)

  return (
    <div className={chart.plot}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={chart.chart}
        role="img"
        aria-label="Total value of your assets per day"
        onMouseMove={(e) => onHover(indexAt(e))}
        onMouseLeave={() => onHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={`y-${t}`}>
            <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={ty(t)} y2={ty(t)} className={chart.gridLine} />
            <text x={PLOT_LEFT - 6} y={ty(t) + 3.5} textAnchor="end" className={chart.axisLabel}>
              {t === 0 ? '0' : formatCompactIsk(t)}
            </text>
          </g>
        ))}
        {xTickEdges(Math.max(0, n - 1), X_TICKS).map((i) => (
          <g key={`x-${i}`}>
            <line x1={tx(i)} x2={tx(i)} y1={BASELINE} y2={BASELINE + 6} className={chart.axisTick} />
            {points[i] && (
              <text x={tx(i)} y={BASELINE + 22} textAnchor="middle" className={chart.axisLabel}>
                {formatTick(points[i].t, monthly)}
              </text>
            )}
          </g>
        ))}
        <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={BASELINE} y2={BASELINE} className={chart.axisTick} />
        <path d={areaPath} className={chart.area} />
        <path d={linePath} className={chart.line} />
        {runs
          .filter((run) => run.length === 1)
          .map(([i]) => (
            <circle key={`solo-${i}`} cx={tx(i)} cy={ty(points[i].total as number)} r={2} className={chart.hoverDot} />
          ))}
        {hovered != null && hover != null && (
          <g>
            <line x1={hoverX} x2={hoverX} y1={PLOT_TOP} y2={BASELINE} className={chart.hoverLine} />
            {hovered.total != null && <circle cx={hoverX} cy={ty(hovered.total)} r={3.5} className={chart.hoverDot} />}
          </g>
        )}
      </svg>
      {hovered != null && hover != null && (
        <div
          className={chart.card}
          style={{
            left: `calc(14px + (100% - 28px) * ${(hoverX / W).toFixed(4)})`,
            transform: hoverFrac > 0.62 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)',
          }}
        >
          <div className={chart.cardHead}>
            <span className={chart.cardMoment}>
              {formatTick(hovered.t, false)} {new Date(hovered.t).getUTCFullYear()}
            </span>
            <span>
              <span className={chart.cardRate} title={hovered.total == null ? undefined : formatIsk(hovered.total)}>
                {formatCompactIsk(hovered.total)}
              </span>{' '}
              <span className={chart.cardUnit}>ISK</span>
            </span>
          </div>
          {hovered.total != null && previous?.total != null && (
            <div className={chart.cardFamily}>
              {hovered.total >= previous.total ? '+' : ''}
              {formatCompactIsk(hovered.total - previous.total)} since {formatTick(previous.t, false)}
            </div>
          )}
          {hovered.total != null && (
            <div className={chart.cardJobs}>
              {VALUE_PARTS.filter((k) => hovered.parts[k] !== 0).map((k) => (
                <div key={k} className={chart.cardJob}>
                  <span className={chart.cardProduct}>{PART_LABEL[k]}</span>
                  <span title={formatIsk(hovered.parts[k])}>{formatCompactIsk(hovered.parts[k])}</span>
                </div>
              ))}
            </div>
          )}
          <div className={chart.cardJobs}>
            {hovered.owners.slice(0, CARD_OWNERS).map((o) => (
              <div key={o.ownerId} className={chart.cardJob}>
                <span className={chart.cardProduct}>
                  {ownerName(o.ownerId)}
                  {o.carried && <span className={chart.cardFamily}> · carried</span>}
                </span>
                <span title={formatIsk(o.value)}>{formatCompactIsk(o.value)}</span>
              </div>
            ))}
            {hovered.owners.length > CARD_OWNERS && (
              <div className={chart.cardMore}>+ {hovered.owners.length - CARD_OWNERS} more</div>
            )}
            {hovered.total == null && <div className={chart.cardMore}>no valuation for this day</div>}
          </div>
          {hovered.unpricedTypes > 0 && (
            <div className={chart.cardFoot}>
              <span className={chart.mono}>{hovered.unpricedTypes}</span> held types had no price that day and are left
              out
            </div>
          )}
        </div>
      )}
    </div>
  )
}
