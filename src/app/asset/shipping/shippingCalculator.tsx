'use client'

// The whole page's interaction: a wide textarea on the left, a Suspense
// boundary on the right.
//
// The point of the Suspense boundary here is timing. The estimate is a server
// action whose promise is created in the debounce timer, so `setRequest` is a
// plain state update (deliberately NOT wrapped in startTransition — a
// transition would keep the previous results on screen while the new ones
// load, and the whole ask is that the loader appear the moment typing stops).
// The boundary is keyed on the request id so each new paste remounts it and
// re-suspends rather than reusing the settled tree from the last one.
import { Suspense, useEffect, useRef, useState } from 'react'

import { SkeletonLines } from '../../skeleton'

import { quoteShipping, type ShippingEstimate } from './actions'
import styles from './shipping.module.css'
import { ShippingResults } from './shippingResults'

// How long the textarea has to be quiet before anything is priced. Every
// estimate is one innomin.at request against a site-wide budget plus two
// kumgo.space quotes, so this is a real throttle, not just polish — a paste
// followed by an edit must not cost two appraisals.
const DEBOUNCE_MS = 250

type Request = { id: number; promise: Promise<ShippingEstimate> }

// Nothing is priced until the box has something in it, so the right half needs
// something to say in the meantime.
const Placeholder = () => (
  <p className={styles.muted}>
    Paste a list — an inventory copy, a multibuy list, or one item name per line — and the Jita-sell value, the
    collateral to put on the contract, and both freight quotes appear here.
  </p>
)

// The loader. `aria-busy` + a live region so it's announced, not just drawn.
const Pending = () => (
  <div className={styles.pending} aria-busy="true">
    <span className={styles.srOnly} role="status">
      Pricing…
    </span>
    <p className={styles.pendingLabel}>
      Appraising and quoting freight…
      <br />
      <span className={styles.muted}>Appraisals share one queue site-wide, so this can wait its turn.</span>
    </p>
    <SkeletonLines count={6} />
  </div>
)

export const ShippingCalculator = () => {
  const [text, setText] = useState('')
  const [request, setRequest] = useState<Request | null>(null)
  // Monotonic, so a request that resolves out of order can never be mistaken
  // for the current one — the boundary's key changes with it.
  const nextId = useRef(0)

  useEffect(() => {
    if (text.trim() === '') {
      setRequest(null)
      return
    }
    const timer = setTimeout(() => {
      nextId.current += 1
      setRequest({
        id: nextId.current,
        // The action never throws on its own, but a dropped connection would
        // reject the call itself — caught here so `use()` always resolves and
        // the failure reads as a message rather than an error boundary.
        promise: quoteShipping(text).catch((): ShippingEstimate => ({
          ok: false,
          message: 'Could not reach the server — try again.',
        })),
      })
    }, DEBOUNCE_MS)
    // Every keystroke re-runs this effect, so the pending timer is cleared and
    // the 250 ms starts over: only the last edit of a burst is ever priced.
    return () => clearTimeout(timer)
  }, [text])

  return (
    <div className={styles.split}>
      <div className={styles.pane}>
        <label className={styles.label} htmlFor="manifest">
          Items
        </label>
        <textarea
          id="manifest"
          className={styles.textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={30}
          placeholder={'Tritanium\t1,000\nRifter x5\nDamage Control II'}
        />
      </div>
      <div className={styles.pane} aria-labelledby="rates-heading">
        {/* The counterpart to the textarea's "Items" — it sits outside the
            Suspense boundary so the column is titled in every state, including
            while the loader is up. */}
        <span className={styles.label} id="rates-heading">
          Rates
        </span>
        {request == null ? (
          <Placeholder />
        ) : (
          <Suspense key={request.id} fallback={<Pending />}>
            <ShippingResults promise={request.promise} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
