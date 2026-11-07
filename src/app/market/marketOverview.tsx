'use client'

import { useMemo } from 'react'

import { formatIsk, formatIskValue } from '../isk'
import { TypeName } from '../typeName'
import { bucketTrades, topTypesByValue, type Bucket, type TypeTotal } from './aggregate'
import { capitalize, SIDE_COPY, type SideCopy } from './sides'
import type { Side, Trade } from './trade'
import { windowOption } from './windows'
import styles from './market.module.css'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const TOP_N = 16

type MarketOverviewProps = {
  // Server-anchored "now" (epoch ms) so window math agrees across SSR/hydration.
  now: number
  // The active tab. The view gives only the trades on this side.
  side: Side
  trades: Trade[]
  windowDays: number
  typeNamesPromise: Promise<Record<number, string>>
}

// A titled card. The "Top items" tile is wide (spans two of the four columns,
// = 50%); the bar chart and the prior-period tile are one column each (= 25%).
const TopItems = ({
  title,
  subtitle,
  copy,
  items,
  typeNamesPromise,
  wide = false,
}: {
  title: string
  subtitle: string
  copy: SideCopy
  items: TypeTotal[]
  typeNamesPromise: Promise<Record<number, string>>
  wide?: boolean
}) => (
  <div className={wide ? `${styles.tile} ${styles.tileWide}` : styles.tile}>
    <div className={styles.tileHead}>
      <h2 className={styles.tileTitle}>{title}</h2>
      <span className={styles.tileSub}>{subtitle}</span>
    </div>
    {items.length > 0 ? (
      <ol className={styles.topList}>
        {items.map((it, i) => (
          <li key={it.typeId} className={styles.topRow}>
            <span className={styles.topRank}>#{i + 1}</span>
            <span className={styles.topName}>
              <TypeName id={it.typeId} promise={typeNamesPromise} />
            </span>
            <span className={styles.topQty} title={`${it.quantity.toLocaleString('en-US')} ${copy.verb}`}>
              ×{it.quantity.toLocaleString('en-US')}
            </span>
            <span className={styles.topValue} title={formatIsk(it.total)}>
              {formatIskValue(it.total)}
            </span>
          </li>
        ))}
      </ol>
    ) : (
      <p className={styles.empty}>No {copy.noun} in this period.</p>
    )}
  </div>
)

const granularityLabel = (bucketHours: number) =>
  bucketHours === 1 ? 'hourly' : bucketHours < 24 ? `${bucketHours}-hour` : 'daily'

const bucketTip = (b: Bucket, bucketHours: number) => {
  const start = new Date(b.start)
  // Sub-day buckets need the hour to disambiguate; daily buckets just the date.
  const when = bucketHours < 24 ? start.toISOString().slice(0, 16).replace('T', ' ') : start.toISOString().slice(0, 10)
  return `${when} — ${formatIsk(b.total)}`
}

const TradeBars = ({ copy, buckets, bucketHours }: { copy: SideCopy; buckets: Bucket[]; bucketHours: number }) => {
  const max = Math.max(1, ...buckets.map((b) => b.total))
  return (
    <div className={styles.tile}>
      <div className={styles.tileHead}>
        <h2 className={styles.tileTitle}>{capitalize(copy.noun)} over time</h2>
        <span className={styles.tileSub}>{granularityLabel(bucketHours)}</span>
      </div>
      <div
        className={styles.bars}
        role="img"
        aria-label={`Total ${copy.noun} per ${granularityLabel(bucketHours)} period`}
      >
        {buckets.map((b) => (
          <div key={b.start} className={styles.barCol} title={bucketTip(b, bucketHours)}>
            <div className={styles.bar} style={{ height: `${(b.total / max) * 100}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

export const MarketOverview = ({ now, side, trades, windowDays, typeNamesPromise }: MarketOverviewProps) => {
  const opt = windowOption(windowDays)
  const copy = SIDE_COPY[side]

  const { current, previous, buckets } = useMemo(() => {
    const currentStart = now - windowDays * DAY_MS
    const previousStart = now - 2 * windowDays * DAY_MS
    return {
      current: topTypesByValue(trades, currentStart, now, TOP_N),
      previous: topTypesByValue(trades, previousStart, currentStart, TOP_N),
      buckets: bucketTrades(trades, currentStart, now, opt.bucketHours * HOUR_MS),
    }
  }, [trades, now, windowDays, opt.bucketHours])

  return (
    <section className={styles.overview}>
      <TopItems
        wide
        title={`Top items ${copy.verb}`}
        subtitle={`by ISK over the last ${opt.label}`}
        copy={copy}
        items={current}
        typeNamesPromise={typeNamesPromise}
      />
      <TradeBars copy={copy} buckets={buckets} bucketHours={opt.bucketHours} />
      <TopItems
        title="Previous period"
        subtitle={`prior ${opt.label}`}
        copy={copy}
        items={previous}
        typeNamesPromise={typeNamesPromise}
      />
    </section>
  )
}
