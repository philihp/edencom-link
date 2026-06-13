import { formatIndex } from './industryIndex'
import styles from './structures.module.css'

type SparklineProps = {
  values: number[]
  label?: string
}

// Tiny line chart for the 7-day cost-index history. The SVG is sized in CSS to
// 100px wide and one line-height tall; the viewBox uses a fixed coordinate
// space and the path scales (preserveAspectRatio="none") so the line stretches
// to whatever line height the surrounding text resolves to. To the left of the
// chart we stack the range it covers — max as a superscript on top, min as a
// subscript on the bottom — so the reader can read the absolute scale without
// having to look up at the current % to know roughly where the line sits.
export const Sparkline = ({ values, label }: SparklineProps) => {
  if (values.length < 2) return <span className={styles.sparklineCell} aria-hidden />

  const w = 100
  const h = 20
  const pad = 1
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = (w - pad * 2) / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = pad + i * step
      const y = pad + (1 - (v - min) / range) * (h - pad * 2)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const trend = values[values.length - 1] >= values[0] ? 'rising' : 'falling'

  return (
    <span className={styles.sparklineCell}>
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
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  )
}
