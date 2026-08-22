import type { ReactNode } from 'react'

import type { ShipOwner } from '../../ship/[itemId]/shipHeading'
import styles from './identity.module.css'

// The block the viewer opens with: what this hull is called, what it is, whose
// it is, where it sits, and the one action the page offers. The design's
// identity strip — accent rule down its left edge, actions on the right,
// everything else stacked under the name once the viewport is narrow.

export type ShipIdentityProps = {
  name: string
  typeName: string
  groupName: string | null
  itemId: string
  owner: ShipOwner
  // "Cold Storage, C-J6MT" — the nearest place and the system it's in, drawn
  // from the same breadcrumb above. Null when the location chain is unreadable
  // (an RLS gap on a container we can't see).
  location: string | null
  actions?: ReactNode
}

export const ShipIdentity = ({ name, typeName, groupName, itemId, owner, location, actions }: ShipIdentityProps) => (
  <section className={styles.identity}>
    <div className={styles.main}>
      <div className={styles.titleRow}>
        <h1 className={`${styles.title} serif`}>{name}</h1>
        {/* This route only ever renders a hull that exists in a hangar — a
            saved fitting is a plan, and lives at /fitting. Saying which is
            which is the difference between "this ship" and "a ship like this". */}
        <span className={styles.badge}>real hull</span>
      </div>
      <p className={styles.subtitle}>
        <span className="serif">{typeName}</span>
        {groupName ? <> · {groupName.toLowerCase()}</> : null}
        {' · '}
        {owner.portrait ? (
          <img
            className={`${styles.avatar} ${owner.portrait.kind === 'corporation' ? styles.avatarCorporation : ''}`}
            src={owner.portrait.url}
            alt=""
            aria-hidden="true"
            width={20}
            height={20}
          />
        ) : null}
        <span className="serif">{owner.name}</span> · item <code className={styles.itemId}>#{itemId}</code>
      </p>
      {location ? (
        <p className={styles.location}>
          <span className={styles.dot} aria-hidden="true" />
          docked · {location}
        </p>
      ) : null}
    </div>
    {actions ? <div className={styles.actions}>{actions}</div> : null}
  </section>
)
