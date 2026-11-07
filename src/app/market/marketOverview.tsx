'use client'

import { take } from 'ramda'
import { Suspense, use, useMemo, type ReactNode } from 'react'

import { Donut } from '../charts/donut'
import { formatIsk, formatIskValue } from '../isk'
import { TypeName } from '../typeName'
import {
  bucketTrades,
  topCounterpartiesByValue,
  topTypesByValue,
  type Bucket,
  type CounterpartyTotal,
  type TypeTotal,
} from './aggregate'
import { counterpartyImage, counterpartyShare, typeShare, type CounterpartyKind } from './shares'
import { capitalize, counterpartyLabel, SIDE_COPY, type SideCopy } from './sides'
import type { Side, Trade } from './trade'
import { windowOption } from './windows'
import styles from './market.module.css'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const TOP_N = 16
// Slices in a donut before the rest goes into "other".
const SHARE_SLICES = 8

type MarketOverviewProps = {
  // Server-anchored "now" (epoch ms) so window math agrees across SSR/hydration.
  now: number
  // The active tab. The view gives only the trades on this side.
  side: Side
  trades: Trade[]
  windowDays: number
  // client_id → name. An id with no name shows its raw id.
  counterpartyNames: Record<number, string>
  // client_id → kind, for the portrait or logo. An id with no kind shows no image.
  counterpartyKinds: Record<number, CounterpartyKind>
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

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

// The counterparties of the active side, ranked by ISK: "Top buyers" on the
// sales tab, "Top sellers" on the purchases tab. Each row shows the portrait
// (character) or logo (corporation, alliance) when the kind of the id is known.
const TopCounterparties = ({
  copy,
  subtitle,
  rows,
  names,
  kinds,
}: {
  copy: SideCopy
  subtitle: string
  rows: CounterpartyTotal[]
  names: Record<number, string>
  kinds: Record<number, CounterpartyKind>
}) => (
  <div className={`${styles.tile} ${styles.tileWide}`}>
    <div className={styles.tileHead}>
      <h2 className={styles.tileTitle}>Top {copy.counterparty}s</h2>
      <span className={styles.tileSub}>{subtitle}</span>
    </div>
    {rows.length > 0 ? (
      <ol className={styles.topList}>
        {rows.map((r, i) => {
          const image = counterpartyImage(kinds[r.clientId], r.clientId)
          return (
            <li key={r.clientId} className={`${styles.topRow} ${styles.whoRow}`}>
              <span className={styles.topRank}>#{i + 1}</span>
              {image === null ? (
                <span className={styles.whoImage} aria-hidden />
              ) : (
                <img className={styles.whoImage} src={image} alt="" width={20} height={20} loading="lazy" />
              )}
              <span className={`${styles.topName} serif`}>{counterpartyLabel(names)(r.clientId)}</span>
              <span className={styles.topQty}>{plural(r.count, 'trade')}</span>
              <span className={styles.topValue} title={formatIsk(r.total)}>
                {formatIskValue(r.total)}
              </span>
            </li>
          )
        })}
      </ol>
    ) : (
      <p className={styles.empty}>No {copy.noun} in this period.</p>
    )}
  </div>
)

// A tile that holds one donut. The donut can be taller than the tile, so the
// body scrolls.
const ShareTile = ({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) => (
  <div className={styles.tile}>
    <div className={styles.tileHead}>
      <h2 className={styles.tileTitle}>{title}</h2>
      <span className={styles.tileSub}>{subtitle}</span>
    </div>
    <div className={styles.shareBody}>{children}</div>
  </div>
)

// The donut of ISK share per item type. It waits for the type names; until
// they come, the slices show the raw type ids.
const TypeDonutNamed = ({
  rows,
  caption,
  promise,
}: {
  rows: TypeTotal[]
  caption: string
  promise: Promise<Record<number, string>>
}) => (
  <Donut
    data={typeShare(use(promise))(rows)}
    limit={SHARE_SLICES}
    unit="isk"
    caption={caption}
    title="ISK share by item"
  />
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

export const MarketOverview = ({
  now,
  side,
  trades,
  windowDays,
  counterpartyNames,
  counterpartyKinds,
  typeNamesPromise,
}: MarketOverviewProps) => {
  const opt = windowOption(windowDays)
  const copy = SIDE_COPY[side]

  const { current, allTypes, counterparties, previous, buckets } = useMemo(() => {
    const currentStart = now - windowDays * DAY_MS
    const previousStart = now - 2 * windowDays * DAY_MS
    // Every type and every counterparty in the window. The lists show the top
    // rows; the donuts take all rows and put the rest into "other".
    const types = topTypesByValue(trades, currentStart, now, Infinity)
    return {
      current: take(TOP_N, types),
      allTypes: types,
      counterparties: topCounterpartiesByValue(trades, currentStart, now, Infinity),
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
      <TopCounterparties
        copy={copy}
        subtitle={`by ISK over the last ${opt.label}`}
        rows={take(TOP_N, counterparties)}
        names={counterpartyNames}
        kinds={counterpartyKinds}
      />
      <ShareTile title={`ISK by ${copy.counterparty}`} subtitle={`top ${SHARE_SLICES} and other`}>
        <Donut
          data={counterpartyShare(counterpartyNames)(counterparties)}
          limit={SHARE_SLICES}
          unit="isk"
          caption={`isk ${copy.verb}`}
          title={`ISK share by ${copy.counterparty}`}
        />
      </ShareTile>
      <ShareTile title="ISK by item" subtitle={`top ${SHARE_SLICES} and other`}>
        <Suspense
          fallback={
            <Donut
              data={typeShare({})(allTypes)}
              limit={SHARE_SLICES}
              unit="isk"
              caption={`isk ${copy.verb}`}
              title="ISK share by item"
            />
          }
        >
          <TypeDonutNamed rows={allTypes} caption={`isk ${copy.verb}`} promise={typeNamesPromise} />
        </Suspense>
      </ShareTile>
    </section>
  )
}
