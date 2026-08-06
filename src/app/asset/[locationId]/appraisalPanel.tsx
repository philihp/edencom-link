'use client'

import { useEffect, useState } from 'react'

import { formatBisk, formatIsk, formatKisk } from '../../isk'
import styles from './appraisalPanel.module.css'

// What POST /api/appraisal answers with on success (totals only — see the route).
type Appraised = {
  total_sell_value: number
  total_buy_value: number
  line_count: number
  skipped_blueprints?: number
  unpriced?: string[]
  cached?: boolean
}

type State =
  { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; value: Appraised } | { phase: 'error'; message: string }

// The saved-appraisal link, which is a second request: the price itself leaves
// nothing behind on innomin.at, while saving stores it there and gets an id.
// Only ever taken on the explicit arrow click, and the answer replaces the
// button with a plain link so it can be middle-clicked, copied, or opened in a
// new tab — the old flow popped the tab open itself, which browsers block.
type Link = { phase: 'idle' } | { phase: 'saving' } | { phase: 'ready'; url: string } | { phase: 'failed' }

// Small values in bISK round to a meaningless "0 bISK", so anything under a
// tenth of a billion reads better in kISK. Both figures share whichever unit the
// larger one picks, so sell and buy stay comparable at a glance.
const BISK_FLOOR = 100_000_000
const unitFor = (sell: number, buy: number) => (Math.max(sell, buy) < BISK_FLOOR ? formatKisk : formatBisk)

// Everything the totals don't say: exact ISK, how many lines were priced, and
// anything deliberately left out. Shown on hover rather than beside the figures,
// because the panel sits in a corner and this is the answer to "why that number".
const describe = (value: Appraised): string =>
  [
    `${formatIsk(value.total_sell_value)} sell / ${formatIsk(value.total_buy_value)} buy`,
    `${value.line_count} ${value.line_count === 1 ? 'type' : 'types'}`,
    ...(value.skipped_blueprints ? [`${value.skipped_blueprints} blueprints skipped`] : []),
    ...(value.unpriced?.length ? [`${value.unpriced.length} unpriced`] : []),
    ...(value.cached ? ['cached'] : []),
  ].join(' · ')

// Appraisals drain from one global queue, so a click can genuinely be waiting
// its turn rather than working. Past a couple of seconds the wait is named and
// counted — an ellipsis that sits there for half a minute reads as broken.
const QUIET_SECONDS = 2

type AppraisalPanelProps = {
  // Item ids (a selection of rows, a ship, a container) or a single location id.
  // An empty list leaves the button present but disabled, so the control doesn't
  // appear and vanish as rows are checked.
  targets: string[]
  label: string
  // Nothing to say when there's nothing selected; the caller words it.
  emptyHint?: string
}

// Appraise a set of targets on demand: the high (sell) and low (buy) totals,
// stacked so their digits line up, plus an arrow that saves the appraisal
// upstream and turns into a link to it.
//
// Deliberately lazy — pricing anything on load would blow the shared hourly
// budget in a single page view — and deliberately not cached: the answer is
// discarded when the selection changes, because it described the old one.
export const AppraisalPanel = ({ targets, label, emptyHint }: AppraisalPanelProps) => {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [link, setLink] = useState<Link>({ phase: 'idle' })
  const [waited, setWaited] = useState(0)

  // A price quoted for a selection is only true of that selection. Changing it
  // resets the panel rather than leaving a stale figure attached to new rows.
  const key = targets.join(',')
  useEffect(() => {
    setState({ phase: 'idle' })
    setLink({ phase: 'idle' })
  }, [key])

  useEffect(() => {
    if (state.phase !== 'loading') return
    const startedAt = Date.now()
    setWaited(0)
    const tick = setInterval(() => setWaited(Math.round((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(tick)
  }, [state.phase])

  const post = async (save: boolean) => {
    const response = await fetch('/api/appraisal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets, ...(save && { save: true }) }),
    })
    const body = await response.json().catch(() => null)
    return { response, body }
  }

  const run = async () => {
    setState({ phase: 'loading' })
    setLink({ phase: 'idle' })
    try {
      const { response, body } = await post(false)
      if (!response.ok || !body?.ok) {
        const retry = typeof body?.retry_after_seconds === 'number' ? ` — retry in ${body.retry_after_seconds}s` : ''
        // A rate limit gets the short form: the route's sentence is written for
        // the MCP tool and is far too long for a corner of the page. Everything
        // else keeps the route's own message, which knows what went wrong.
        const message = response.status === 429 ? `rate limited${retry}` : `${body?.error ?? 'appraisal unavailable'}`
        setState({ phase: 'error', message })
        return
      }
      setState({ phase: 'done', value: body as Appraised })
    } catch {
      setState({ phase: 'error', message: 'appraisal unavailable' })
    }
  }

  // Re-run the same targets with save: true, which makes innomin.at store the
  // appraisal and hand back an id. Unlike the price itself this leaves a record
  // on their side, so it only ever happens on this explicit click.
  const createLink = async () => {
    setLink({ phase: 'saving' })
    try {
      const { response, body } = await post(true)
      const url = typeof body?.appraisal_url === 'string' ? body.appraisal_url : null
      if (!response.ok || !body?.ok || !url) {
        setLink({ phase: 'failed' })
        return
      }
      setLink({ phase: 'ready', url })
    } catch {
      setLink({ phase: 'failed' })
    }
  }

  if (state.phase === 'loading') {
    return (
      <span
        className={styles.pending}
        title="Appraisals share one queue across the whole site, so a burst of clicks waits its turn."
      >
        {waited <= QUIET_SECONDS ? 'appraising…' : `queued ${waited}s…`}
      </span>
    )
  }

  if (state.phase === 'error') {
    return (
      <span className={styles.panel}>
        <span className={styles.error}>{state.message}</span>
        <button type="button" className={styles.secondary} onClick={run}>
          Try again
        </button>
      </span>
    )
  }

  if (state.phase === 'done') {
    const format = unitFor(state.value.total_sell_value, state.value.total_buy_value)
    return (
      <span className={styles.panel}>
        {/* High over low, one per line: the two figures are read against each
            other, and stacking them lines the digits up under the tabular face. */}
        <span className={styles.figures} title={describe(state.value)}>
          <span className={styles.figure}>
            <span className={styles.figureLabel}>high</span>
            {format(state.value.total_sell_value)}
            {/* Cheap honesty about staleness: this came from the 5-minute cache. */}
            {state.value.cached ? '*' : ''}
          </span>
          <span className={styles.figure}>
            <span className={styles.figureLabel}>low</span>
            {format(state.value.total_buy_value)}
          </span>
        </span>
        {link.phase === 'ready' ? (
          // A link, not another pop-up: the user decides where it opens.
          <a className={styles.primary} href={link.url} target="_blank" rel="noopener noreferrer">
            Appraisal ↗
          </a>
        ) : (
          <button
            type="button"
            className={styles.primary}
            title={
              link.phase === 'failed'
                ? 'Could not save the appraisal — try again.'
                : 'Save this appraisal on innomin.at and link to it'
            }
            disabled={link.phase === 'saving'}
            onClick={createLink}
            aria-label="Create a link to this appraisal on innomin.at"
          >
            {link.phase === 'saving' ? '…' : '↗'}
          </button>
        )}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={styles.secondary}
      onClick={run}
      disabled={targets.length === 0}
      title={targets.length === 0 ? emptyHint : undefined}
    >
      {label}
    </button>
  )
}
