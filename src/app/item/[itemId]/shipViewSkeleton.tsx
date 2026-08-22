import styles from './shipView.module.css'

// The shape of the view, held while the several-MB protobuf decode and the
// WASM engine load — the same reason /ship has a FitPlaceholder. In its own
// module so the dynamic wrapper can show it without pulling the view (and the
// engine chunk behind it) into the page's first load.
export const ShipViewSkeleton = () => (
  <div className={styles.viewer}>
    <div className={styles.fitLayout}>
      <div className={styles.ringBox}>
        <div className={`${styles.ring} ${styles.ringPending}`}>
          <span className={styles.ringGuide} aria-hidden="true" />
          <div className={styles.hub}>
            <span className={styles.hullGroup}>reading the fit…</span>
          </div>
        </div>
      </div>
      <div className={styles.fitColumn} />
    </div>
  </div>
)
