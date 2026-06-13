import styles from './structures.module.css'

type SparklineProps = {
  values: number[]
  label?: string
}

// Tiny line chart for the 7-day cost-index history. Sized in CSS to 100px wide
// and one line-height tall; the viewBox uses a fixed coordinate space and the
// path scales (preserveAspectRatio="none") so it stretches to whatever line
// height the surrounding text resolves to.
export const Sparkline = ({ values, label }: SparklineProps) => {
  if (values.length < 2) return <span className={styles.sparkline} aria-hidden />

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
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ? `${label}, ${trend}` : trend}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
