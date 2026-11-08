import industryStyles from '../industry.module.css'
import styles from './planner.module.css'

// A tab that has its frame but not yet its contents: one panel, named, with a
// line saying what will go there. Every tab starts here and is replaced by its
// own view as it is built (see the planner plan).
export const EmptyTab = ({ title, note }: { title: string; note: string }) => (
  <section className={industryStyles.panel}>
    <div className={industryStyles.panelHead}>
      <span className={industryStyles.panelTitle}>{title}</span>
    </div>
    <p className={styles.empty}>{note}</p>
  </section>
)
