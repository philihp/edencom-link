'use client'

import { filter, take } from 'ramda'
import { Suspense, use, useMemo, type ReactNode } from 'react'

import { Donut } from '../charts/donut'
import { formatIsk, formatIskValue } from '../isk'
import { TypeName } from '../typeName'
import {
  inWindow,
  onSide,
  topCounterpartiesByValue,
  topTypesByValue,
  totalsOf,
  type CounterpartyTotal,
  type Totals,
  type TypeTotal,
} from './aggregate'
import { flowBuckets, type FlowBucket } from './flow'
import { FlowChart, FlowLegend } from './flowChart'
import { counterpartyImage, counterpartyShare, typeShare, type CounterpartyKind } from './shares'
import { counterpartyLabel, SIDE_COPY, type SideCopy } from './sides'
import { isMarket, type Side, type Trade } from './trade'
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
  // Both sides, for the totals.
  allTrades: Trade[]
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

// Sales and purchases over the window, both sides whatever the tab. The page
// shows it above the tabs, a full row wide.
export const MarketFlow = ({
  now,
  side,
  allTrades,
  windowDays,
}: {
  now: number
  side: Side
  allTrades: Trade[]
  windowDays: number
}) => {
  const { bucketHours } = windowOption(windowDays)
  const rows = useMemo(
    () => flowBuckets(allTrades, now - windowDays * DAY_MS, now, bucketHours * HOUR_MS),
    [allTrades, now, windowDays, bucketHours]
  )
  return (
    <section className={styles.flowSection}>
      <FlowTile side={side} rows={rows} bucketHours={bucketHours} />
    </section>
  )
}

const FlowTile = ({ side, rows, bucketHours }: { side: Side; rows: FlowBucket[]; bucketHours: number }) => (
  <div className={styles.tile}>
    <div className={styles.tileHead}>
      <h2 className={styles.tileTitle}>ISK flow</h2>
      <FlowLegend side={side} />
      <span className={styles.tileSub}>{granularityLabel(bucketHours)} · utc</span>
    </div>
    <FlowChart rows={rows} bucketHours={bucketHours} side={side} />
  </div>
)

// The window in numbers: what we sold, what we bought, and the difference.
const FlowTotals = ({ subtitle, sales, purchases }: { subtitle: string; sales: Totals; purchases: Totals }) => (
  <div className={styles.tile}>
    <div className={styles.tileHead}>
      <h2 className={styles.tileTitle}>Totals</h2>
      <span className={styles.tileSub}>{subtitle}</span>
    </div>
    <dl className={styles.totals}>
      <dt>sales</dt>
      <dd title={formatIsk(sales.total)}>
        {formatIskValue(sales.total)} <span className={styles.totalsCount}>{plural(sales.count, 'trade')}</span>
      </dd>
      <dt>purchases</dt>
      <dd title={formatIsk(purchases.total)}>
        {formatIskValue(purchases.total)} <span className={styles.totalsCount}>{plural(purchases.count, 'trade')}</span>
      </dd>
      <dt>net</dt>
      <dd title={formatIsk(sales.total - purchases.total)}>{formatIskValue(sales.total - purchases.total)}</dd>
    </dl>
  </div>
)

export const MarketOverview = ({
  now,
  side,
  trades,
  allTrades,
  windowDays,
  counterpartyNames,
  counterpartyKinds,
  typeNamesPromise,
}: MarketOverviewProps) => {
  const opt = windowOption(windowDays)
  const copy = SIDE_COPY[side]

  const { current, allTypes, counterparties, previous } = useMemo(() => {
    const currentStart = now - windowDays * DAY_MS
    const previousStart = now - 2 * windowDays * DAY_MS
    // Every type and every counterparty in the window. The lists show the top
    // rows; the donuts take all rows and put the rest into "other". A contract
    // has no price per item, so the item tiles use market trades only. The
    // counterparty tiles use contracts too.
    const market = filter(isMarket, trades)
    const types = topTypesByValue(market, currentStart, now, Infinity)
    return {
      current: take(TOP_N, types),
      allTypes: types,
      counterparties: topCounterpartiesByValue(trades, currentStart, now, Infinity),
      previous: topTypesByValue(market, previousStart, currentStart, TOP_N),
    }
  }, [trades, now, windowDays])

  // The totals show both sides, whatever the tab.
  const { salesTotals, purchaseTotals } = useMemo(() => {
    const inCurrent = filter(inWindow(now - windowDays * DAY_MS, now), allTrades)
    return {
      salesTotals: totalsOf(onSide('sell')(inCurrent)),
      purchaseTotals: totalsOf(onSide('buy')(inCurrent)),
    }
  }, [allTrades, now, windowDays])

  return (
    <section className={styles.overview}>
      <TopItems
        wide
        title={`Top items ${copy.verb}`}
        subtitle={`market only · by ISK over the last ${opt.label}`}
        copy={copy}
        items={current}
        typeNamesPromise={typeNamesPromise}
      />
      <TopItems
        title="Previous period"
        subtitle={`market only · prior ${opt.label}`}
        copy={copy}
        items={previous}
        typeNamesPromise={typeNamesPromise}
      />
      <ShareTile title="ISK by item" subtitle={`market only · top ${SHARE_SLICES} and other`}>
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
      <FlowTotals subtitle={`last ${opt.label}`} sales={salesTotals} purchases={purchaseTotals} />
    </section>
  )
}
