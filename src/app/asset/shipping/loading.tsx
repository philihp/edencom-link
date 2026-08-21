import { LoadingShell, SkeletonLines } from '../../skeleton'

import styles from './shipping.module.css'

// Without this, the segment falls back to ../loading.tsx — "Assets" over a
// System/Location/Items skeleton — which is flushed before the auth check
// resolves and makes this page look like it landed on the assets browser
// (or on /asset/[locationId], which is what it gets mistaken for). Every
// other subpage under /asset carries its own for the same reason.
//
// It holds the real two-column split, so the textarea doesn't jump across the
// page when the client component takes over: the same class the real box uses
// gives a ghost of exactly its size.
const ShippingLoading = () => (
  <LoadingShell title="Shipping">
    <div className={styles.split}>
      <div className={styles.pane}>
        <span className={styles.label}>Items</span>
        <div className={styles.textarea} aria-hidden="true" />
      </div>
      <div className={styles.pane}>
        <SkeletonLines count={3} />
      </div>
    </div>
  </LoadingShell>
)
export default ShippingLoading
