'use client'

// The right-hand half: whatever the pending estimate resolves to.
//
// A client component rather than a server one because the promise it reads is
// minted in an event (the debounce timer), not by a navigation — `use()` on
// that promise is what suspends the boundary around it, which is what puts the
// loader on screen the instant the typing stops.
import { use } from 'react'

import { formatBisk, formatIsk } from '../../isk'

import type { QuotedDirection, ShippingEstimate } from './actions'
import styles from './shipping.module.css'

// Volume runs from a few m³ (a crate of ammo) to hundreds of thousands (a
// freighter load), so it gets ordinary separators and at most one decimal —
// enough to tell 0.9 m³ from nothing at all.
const formatVolume = (m3: number) => `${m3.toLocaleString('en-US', { maximumFractionDigits: 1 })} m³`

// bISK for the headline figures, which are read against each other; the exact
// ISK is one hover away, because a courier contract is typed in whole ISK.
const Figure = ({ label, isk, strong }: { label: string; isk: number; strong?: boolean }) => (
  <div className={strong ? `${styles.figure} ${styles.figureStrong}` : styles.figure}>
    <span className={styles.figureLabel}>{label}</span>
    <span className={styles.figureValue} title={formatIsk(isk)}>
      {formatBisk(isk)}
    </span>
  </div>
)

const DirectionCard = ({ direction }: { direction: QuotedDirection }) => (
  <section className={styles.card}>
    <h3 className={styles.cardTitle}>{direction.label}</h3>
    {direction.ok ? (
      <>
        <Figure label="Total cost" isk={direction.totalIsk} strong />
        <Figure label="Contract reward" isk={direction.rewardIsk} />
        {direction.rushFeeIsk > 0 ? <Figure label="Rush fee" isk={direction.rushFeeIsk} /> : null}
        <p className={styles.cardNote}>{direction.route}</p>
        {direction.deliverTo ? <p className={styles.cardNote}>Deliver to {direction.deliverTo}</p> : null}
      </>
    ) : (
      <p className={styles.error}>{direction.message}</p>
    )}
  </section>
)

export const ShippingResults = ({ promise }: { promise: Promise<ShippingEstimate> }) => {
  const estimate = use(promise)

  if (!estimate.ok) return <p className={styles.error}>{estimate.message}</p>

  return (
    <div className={styles.results}>
      <section className={styles.card}>
        <h3 className={styles.cardTitle}>
          Cargo
          {estimate.cached ? <span className={styles.badge}>cached</span> : null}
        </h3>
        {/* The recommendation, not just a valuation: this is the number to
            type into the courier contract's collateral field, and every
            freight quote below was priced against it. */}
        <Figure label="Recommended collateral (Jita sell)" isk={estimate.sellIsk} strong />
        <Figure label="Jita buy" isk={estimate.buyIsk} />
        <p className={styles.cardNote}>
          {formatVolume(estimate.volumeM3)} · {estimate.lineCount} item{estimate.lineCount === 1 ? '' : 's'}
        </p>
      </section>

      {estimate.directions.map((direction) => (
        <DirectionCard key={direction.label} direction={direction} />
      ))}

      {/* An unpriced line doesn't blank the page — a single typo in a
          forty-line paste shouldn't — but the collateral above then covers
          less than the load, which is worth saying plainly. */}
      {estimate.unpriced.length > 0 ? (
        <section className={styles.warning}>
          <p>
            {estimate.unpriced.length} line{estimate.unpriced.length === 1 ? '' : 's'} could not be priced, so the
            collateral above does not cover {estimate.unpriced.length === 1 ? 'it' : 'them'}:
          </p>
          <ul>
            {estimate.unpriced.map((line) => (
              <li key={line.name}>
                {line.name}
                {line.suggestions.length > 0 ? (
                  <span className={styles.muted}> — did you mean {line.suggestions.join(', ')}?</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {estimate.ignored.length > 0 ? (
        <p className={styles.muted}>
          Ignored {estimate.ignored.length} line{estimate.ignored.length === 1 ? '' : 's'}:{' '}
          {estimate.ignored.join(', ')}
        </p>
      ) : null}

      <p className={styles.muted}>
        Prices from innomin.at, freight quoted live by kumgo.space. Set the courier contract reward to the contract
        reward and its collateral to the recommended collateral.
      </p>
    </div>
  )
}
