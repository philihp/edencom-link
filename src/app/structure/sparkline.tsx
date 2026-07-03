import { formatIndex } from './industryIndex'
import styles from './structures.module.css'

type SparklineProps = {
  values: number[]
  // Count of leading points backed by a real reading; points past this index
  // are the forward-filled flat tail and get drawn at half opacity. Defaults to
  // the full length (everything solid).
  liveCount?: number
  label?: string
  // ISO 8601 of the most recent data point — surfaced in the hover tooltip.
  updatedAt?: string
}

// Format an ISO timestamp for the title-attribute tooltip. Matches the
// YYYY-MM-DD HH:MM, 24-hour format the DateTime component uses elsewhere so
// timestamps read the same in chips and tooltips.
const tooltipFormatter = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const formatUpdatedAt = (iso?: string): string | undefined => {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return `Last updated ${tooltipFormatter.format(d)}`
}

// Tiny line chart for the 30-day cost-index history. The SVG is sized in CSS
// to 100px wide and one line-height tall; the viewBox uses a fixed coordinate
// space and the path scales (preserveAspectRatio="none") so the line stretches
// to whatever line height the surrounding text resolves to. To the left of the
// chart we stack the range it covers — max as a superscript on top, min as a
// subscript on the bottom — so the reader can read the absolute scale without
// having to look up at the current % to know roughly where the line sits.
export const Sparkline = ({ values, liveCount = values.length, label, updatedAt }: SparklineProps) => {
  const tooltip = formatUpdatedAt(updatedAt)

  if (values.length < 2) return <span className={styles.sparklineCell} title={tooltip} aria-hidden />

  const w = 100
  const h = 20
  const pad = 1
  // Cost indices are fractions (0.001 = 0.1%). When the real spread is tighter
  // than that, the line would look perfectly flat and hide the (tiny) trend —
  // so we widen the displayed range to a fixed 0.1% centered on the actual
  // midpoint, rather than the actual min/max, and use that widened range for
  // both the plotted line and the min/max labels beside it.
  const MIN_DISPLAY_RANGE = 0.001
  const actualMin = Math.min(...values)
  const actualMax = Math.max(...values)
  const actualRange = actualMax - actualMin
  const mid = (actualMin + actualMax) / 2
  const [min, max] =
    actualRange < MIN_DISPLAY_RANGE
      ? [mid - MIN_DISPLAY_RANGE / 2, mid + MIN_DISPLAY_RANGE / 2]
      : [actualMin, actualMax]
  const range = max - min || 1
  const step = (w - pad * 2) / (values.length - 1)
  const coords = values.map((v, i) => {
    const x = pad + i * step
    const y = pad + (1 - (v - min) / range) * (h - pad * 2)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  // Split the line where real readings end: the leading segment is solid, the
  // forward-filled tail (the system stopped reporting) is dimmed. The two share
  // the boundary point so the line stays continuous across the seam.
  const live = coords.slice(0, Math.max(liveCount, 1))
  const stale = liveCount < values.length ? coords.slice(liveCount - 1) : []
  const trend = values[values.length - 1] >= values[0] ? 'rising' : 'falling'

  return (
    <span className={styles.sparklineCell} title={tooltip}>
      <span className={styles.sparklineRange} aria-hidden>
        <sup className={styles.sparklineMax}>{formatIndex(max)}</sup>
        <sub className={styles.sparklineMin}>{formatIndex(min)}</sub>
      </span>
      <svg
        className={styles.sparkline}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label ? `${label}, ${trend}` : trend}
      >
        {live.length >= 2 && (
          <polyline
            points={live.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {stale.length >= 2 && (
          <polyline
            points={stale.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </span>
  )
}
