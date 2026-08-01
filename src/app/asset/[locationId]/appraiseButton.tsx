'use client'

import { useEffect, useState } from 'react'

import { formatBisk, formatIsk, formatKisk } from '../../isk'
import styles from './appraiseButton.module.css'

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

// Small values in bISK round to a meaningless "0 bISK", so anything under a
// tenth of a billion reads better in kISK. Both figures share whichever unit the
// larger one picks, so sell and buy stay comparable at a glance.
const BISK_FLOOR = 100_000_000
const formatPair = (sell: number, buy: number): string => {
  const format = Math.max(sell, buy) < BISK_FLOOR ? formatKisk : formatBisk
  return `${format(sell)} / ${format(buy)}`
}

// Everything the totals don't say: exact ISK, how many lines were priced, and
// anything deliberately left out. Shown on hover rather than in the cell,
// because the table is dense and this is the answer to "why that number".
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

// Appraise one target on demand: an item id (a stack, or a ship/container and
// everything inside it) or a location id for the whole hangar. Deliberately
// lazy and per-mount — pricing every row of a station on load would blow the
// shared hourly budget in a single page view, and navigating away is meant to
// discard the answer rather than cache it client-side.
export const AppraiseButton = ({ target, label = 'appraise' }: { target: string; label?: string }) => {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [waited, setWaited] = useState(0)

  useEffect(() => {
    if (state.phase !== 'loading') return
    const startedAt = Date.now()
    setWaited(0)
    const tick = setInterval(() => setWaited(Math.round((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(tick)
  }, [state.phase])

  const run = async () => {
    setState({ phase: 'loading' })
    try {
      const response = await fetch('/api/appraisal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.ok) {
        const retry = typeof body?.retry_after_seconds === 'number' ? ` — retry in ${body.retry_after_seconds}s` : ''
        // A rate limit gets the short form: the route's sentence is written for
        // the MCP tool and is far too long for a table cell. Everything else
        // keeps the route's own message, which knows what actually went wrong.
        const message = response.status === 429 ? `rate limited${retry}` : `${body?.error ?? 'appraisal unavailable'}`
        setState({ phase: 'error', message })
        return
      }
      setState({ phase: 'done', value: body as Appraised })
    } catch {
      setState({ phase: 'error', message: 'appraisal unavailable' })
    }
  }

  if (state.phase === 'loading') {
    return (
      <span
        className={styles.pending}
        title="Appraisals share one queue across the whole site, so a burst of clicks waits its turn."
      >
        {waited <= QUIET_SECONDS ? '…' : `queued ${waited}s…`}
      </span>
    )
  }
  if (state.phase === 'error') return <span className={styles.error}>{state.message}</span>
  if (state.phase === 'done') {
    return (
      <span className={styles.value} title={describe(state.value)}>
        {formatPair(state.value.total_sell_value, state.value.total_buy_value)}
        {/* Cheap honesty about staleness: this came from the 5-minute cache. */}
        {state.value.cached ? '*' : ''}
      </span>
    )
  }
  return (
    <button type="button" className={styles.button} onClick={run}>
      {label}
    </button>
  )
}
