'use client'

import styles from './shipFit.module.css'

// The fit viewer's reserved footprint, standing in from first paint until the
// real thing can draw: the next/dynamic chunk, then the type/dogma protobufs
// (which EveDataProvider renders nothing without), all load client-side, so
// the viewer arrives seconds after the page. Same geometry as the live layout
// — wheel box, stats column, the collapsed simulate line — so the swap fills
// the space in place instead of pushing the module table down.
export const FitPlaceholder = () => (
  <div aria-busy="true">
    <div className={styles.layout}>
      <div className={`${styles.wheel} ${styles.wheelPending}`}>Loading fit viewer…</div>
      <div className={styles.stats} />
    </div>
    <p className={styles.hardwareGhost} aria-hidden="true">
      Load modules &amp; ammo (simulate)
    </p>
  </div>
)
