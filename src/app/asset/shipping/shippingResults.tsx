'use client'

// The right-hand half: whatever the pending estimate resolves to.
//
// A client component rather than a server one because the promise it reads is
// minted in an event (the debounce timer), not by a navigation — `use()` on
// that promise is what suspends the boundary around it, which is what puts the
// loader on screen the instant the typing stops.
//
// Every figure here is full ISK, never abbreviated: these are numbers a player
// types into a courier contract, and "1.234 bISK" is not something you can
// type into the collateral field.
import { use } from 'react'

import { formatIsk } from '../../isk'

import type { QuotedDirection, ShippingEstimate } from './actions'
import { CopyValue } from './copyValue'
import styles from './shipping.module.css'

const formatVolume = (m3: number) => `${m3.toLocaleString('en-US', { maximumFractionDigits: 1 })} m³`

// `copy` marks the figures that get typed into a courier contract. What is
// copied is the bare integer — the rendered form carries thousands separators
// and an "ISK" suffix, neither of which the game's fields want. Rounded UP:
// both of these are amounts that must not come out short, and a fraction of an
// ISK cannot be entered anyway.
const Figure = ({ label, isk, strong, copy }: { label: string; isk: number; strong?: boolean; copy?: string }) => (
  <div className={strong ? `${styles.figure} ${styles.figureStrong}` : styles.figure}>
    <span className={styles.figureLabel}>{label}</span>
    <span className={styles.figureValue}>
      {formatIsk(isk)}
      {copy ? <CopyValue value={String(Math.ceil(isk))} label={copy} /> : null}
    </span>
  </div>
)

const DirectionCard = ({ direction }: { direction: QuotedDirection }) => (
  <section className={styles.card}>
    <h3 className={styles.cardTitle}>{direction.label}</h3>
    {direction.ok ? (
      <>
        <Figure label="Total cost" isk={direction.totalIsk} strong />
        <Figure label="Contract reward" isk={direction.rewardIsk} copy="contract reward" />
        {direction.rushFeeIsk > 0 ? <Figure label="Rush fee" isk={direction.rushFeeIsk} /> : null}
        <p className={styles.cardNote}>
          {direction.lane} · tier {direction.tier} · {direction.rate}
          {direction.collateralFeePercent > 0 ? ` + ${direction.collateralFeePercent}% collateral` : ''}
        </p>
        {direction.deliverTo ? (
          <p className={styles.cardNote}>
            Deliver to {direction.deliverTo}
            <CopyValue value={direction.deliverTo} label="destination station" />
          </p>
        ) : null}
        {direction.collateralCapExceeded ? (
          <p className={styles.error}>This lane will not insure the full value — the tier has a collateral ceiling.</p>
        ) : null}
      </>
    ) : (
      <p className={styles.error}>{direction.message}</p>
    )}
  </section>
)

export const ShippingResults = ({ promise }: { promise: Promise<ShippingEstimate> }) => {
  const estimate = use(promise)

  if (!estimate.ok) return <p className={styles.error}>{estimate.message}</p>

  // KumGo prices by load-size tier and has no standard rate past the largest
  // one it enables — 350,000 m³ today, which is also about where a jump
  // freighter's hold ends. Past it every lane below refuses, so the reason is
  // stated once, up top, instead of only as two identical refusals.
  const overCapacity = estimate.maxVolumeM3 != null && estimate.volumeM3 > estimate.maxVolumeM3

  return (
    <div className={styles.results}>
      {overCapacity ? (
        <section className={styles.warning} role="alert">
          <p>
            <strong>{formatVolume(estimate.volumeM3)} is too big to ship in one contract.</strong> The largest standard
            load is {formatVolume(estimate.maxVolumeM3 ?? 0)} — about a jump freighter&apos;s hold. Split the list, or
            ask KumGo on Discord for a manual quote.
          </p>
        </section>
      ) : null}

      <section className={styles.card}>
        <h3 className={styles.cardTitle}>
          Cargo
          {estimate.cached ? <span className={styles.badge}>cached</span> : null}
        </h3>
        {/* The recommendation, not just a valuation: this is the number to
            type into the courier contract's collateral field, and every
            freight quote below was priced against it. */}
        <Figure label="Recommended collateral (Jita sell)" isk={estimate.sellIsk} strong copy="collateral" />
        <Figure label="Jita buy" isk={estimate.buyIsk} />
        <p className={overCapacity ? styles.cardNoteAlert : styles.cardNote}>
          {formatVolume(estimate.volumeM3)}
          {estimate.maxVolumeM3 != null ? ` of ${formatVolume(estimate.maxVolumeM3)} max` : ''} · {estimate.lineCount}{' '}
          item{estimate.lineCount === 1 ? '' : 's'}
        </p>
      </section>

      {estimate.directions.map((direction) => (
        <DirectionCard key={direction.label} direction={direction} />
      ))}

      {/* The appraiser matches names fuzzily and reports no error when it
          settles on a different item, which silently re-prices the cargo —
          so every substitution is named rather than trusted. */}
      {estimate.substitutions.length > 0 ? (
        <section className={styles.warning} role="alert">
          <p>
            {estimate.substitutions.length === 1 ? 'One line was' : `${estimate.substitutions.length} lines were`}{' '}
            priced as a different item than asked for:
          </p>
          <ul>
            {estimate.substitutions.map((swap) => (
              <li key={swap.input}>
                &ldquo;{swap.input}&rdquo; <span className={styles.muted}>priced as</span> {swap.priced}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
