import { LoadingShell, SkeletonLines, SkeletonTable } from '../skeleton'
import styles from './industry.module.css'

// Holds the page's two-panel shape — the chart's strip, then the job list —
// while the server prices the history.
const IndustryLoading = () => (
  <LoadingShell title="industry">
    <section className={styles.panel} aria-hidden>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>lift rate</span>
      </div>
      <div className={styles.plot}>
        <SkeletonLines count={5} />
      </div>
    </section>
    <section className={`${styles.panel} ${styles.listPanel}`} aria-hidden>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>active jobs</span>
      </div>
      <SkeletonTable
        columns={['owner', 'activity', 'product', 'runs', 'station', 'lift', 'ISK/hr', 'start', 'end', 'remaining']}
        numeric={['runs', 'lift', 'ISK/hr']}
        rows={8}
      />
    </section>
  </LoadingShell>
)
export default IndustryLoading
