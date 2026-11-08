import { SkeletonLines } from '../../skeleton'
import styles from '../industry.module.css'

// Under the layout, so the header and tab strip stay while a tab loads; only
// the tab's panel is held.
const PlannerLoading = () => (
  <section className={styles.panel} aria-hidden aria-busy="true">
    <div className={styles.panelHead}>
      <span className={styles.panelTitle}>&nbsp;</span>
    </div>
    <SkeletonLines count={3} />
  </section>
)
export default PlannerLoading
