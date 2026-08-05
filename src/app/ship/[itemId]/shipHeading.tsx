import type { ReactNode } from 'react'

import { TypeIcon } from '../../typeIcon'
import styles from './shipHeading.module.css'

// Who holds the ship, as the heading draws them: a name plus the portrait or
// logo CCP's image server serves for them. `portrait` is null when the id
// behind the name couldn't be resolved (a shared ship whose owner is outside
// the caller's registration view and missing from the public directory), in
// which case the name stands alone.
export type ShipOwner = {
  name: string
  portrait: { url: string; kind: 'character' | 'corporation' } | null
}

export const characterPortrait = (characterId: number | string): ShipOwner['portrait'] => ({
  url: `https://images.evetech.net/characters/${characterId}/portrait?size=64`,
  kind: 'character',
})

export const corporationLogo = (corporationId: number | string): ShipOwner['portrait'] => ({
  url: `https://images.evetech.net/corporations/${corporationId}/logo?size=64`,
  kind: 'corporation',
})

type ShipHeadingProps = {
  typeId: number
  heading: string
  owner: ShipOwner
  // The share dialog on the owner's own view; the shared view passes nothing.
  actions?: ReactNode
}

// The ship page's identity block: the hull's render to the left of the name
// and its owner, the way the in-game ship info window leads with the render.
// Shared by the signed-in and share-link views so the two can't drift.
export const ShipHeading = ({ typeId, heading, owner, actions }: ShipHeadingProps) => (
  <div className={styles.header}>
    {/* "render" is the big 3D hull art — every Ship-category type has one, and
        both callers have already gated on that category. */}
    <TypeIcon id={typeId} size={64} variation="render" className={styles.render} />
    <div className={styles.identity}>
      <h1 className="serif">{heading}</h1>
      <p className={styles.owner}>
        <span className={styles.ownerLabel}>Owner</span>
        {owner.portrait ? (
          <img
            className={`${styles.ownerAvatar} ${
              owner.portrait.kind === 'corporation' ? styles.ownerAvatarCorporation : ''
            }`}
            src={owner.portrait.url}
            alt=""
            aria-hidden="true"
            width={32}
            height={32}
          />
        ) : null}
        <span className="serif">{owner.name}</span>
      </p>
    </div>
    {actions ? <div className={styles.actions}>{actions}</div> : null}
  </div>
)
