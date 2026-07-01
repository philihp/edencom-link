import styles from './quantity.module.css'

// Renders a stack size grouped with thousands separators (123,456,789) for
// display, while keeping the raw digits (123456789) as the text that actually
// lands on the clipboard when the cell is highlighted and copied. Non-numeric
// values fall through unchanged.
export const Quantity = ({ value }: { value: number | string | null }) => {
  const n = Number(value ?? 1)
  if (!Number.isFinite(n)) return <>{value ?? 1}</>

  return (
    <span className={styles.quantity} data-grouped={n.toLocaleString('en-US')}>
      <span className={styles.raw}>{n}</span>
    </span>
  )
}
