import { LoadingShell, SkeletonLines } from '../../skeleton'
import styles from '../industry.module.css'

const PlannerLoading = () => (
  <LoadingShell title="planner">
    <section className={styles.panel} aria-hidden>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>plan</span>
      </div>
      <SkeletonLines count={3} />
    </section>
  </LoadingShell>
)
export default PlannerLoading
