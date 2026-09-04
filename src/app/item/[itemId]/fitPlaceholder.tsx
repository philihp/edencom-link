'use client'

import styles from './shipFit.module.css'

// The fit viewer's reserved footprint, standing in from first paint until the
// real thing can draw: the next/dynamic chunk, then the type/dogma protobufs
// (which EveDataProvider renders nothing without), all load client-side, so
// the viewer arrives seconds after the page. Same three columns as the live
// layout — the wheel box, the stats column and the simulate line holding the
// hardware browser's column — so the swap fills the space in place instead of
// pushing the module table down.
export const FitPlaceholder = () => (
  <div className={styles.layout} aria-busy="true">
    <div className={`${styles.wheel} ${styles.wheelPending}`}>Loading fit viewer…</div>
    <div className={styles.stats} />
    <p className={styles.hardwareGhost} aria-hidden="true">
      Load modules &amp; ammo (simulate)
    </p>
  </div>
)
