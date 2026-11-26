'use client'

import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'

import chart from '../industry/industry.module.css'
import { formatCompactIsk } from '../industry/lift'
import { formatIsk } from '../isk'
import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../ownerFilter'
import { isTimeWindowDays } from '../timeWindow'
import { usePersist } from '../usePersist'
import { WindowSelect } from '../windowSelect'
import styles from './assets.module.css'
import { AssetsTable, type Location } from './assetsTable'
import { OWNER_STORAGE_KEY } from './filterKey'
import { formatPct, valueSeries, windowChange, windowDays, type ValueRow } from './valuation'
import { ValueChart } from './valueChart'

// The /asset landing page: what the hangar is worth over time, then where it
// is. One owner filter and one window drive both — the owner filter is the
// one the location pages share, so a pick follows the user when they drill
// in. Market and Industry keep the same order: a chart of the whole, then the
// rows behind it.

export const DEFAULT_WINDOW_DAYS = 30
export const WINDOW_STORAGE_KEY = 'asset.window.days'

type AssetsLandingProps = {
  // Server-anchored "now", so the window agrees across hydration.
  now: number
  values: ValueRow[]
  locations: Location[]
  owners: Owners
  // Rendered between the chart and the location table: the search form and
  // the frozen-corpses link, which are server-rendered.
  children?: ReactNode
}

export const AssetsLanding = ({ now, values, locations, owners, children }: AssetsLandingProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)
  const [days, setDays] = usePersist<number>(WINDOW_STORAGE_KEY, DEFAULT_WINDOW_DAYS, (raw) => {
    const parsed = Number(raw)
    return isTimeWindowDays(parsed) ? parsed : undefined
  })
  const [hover, setHover] = useState<number | null>(null)

  const names = useMemo(() => ownerNames(owners), [owners])
  const ownerName = (id: string) => names.get(id) ?? (/^\d+$/.test(id) ? `Corporation #${id}` : 'Former character')

  const points = useMemo(
    () => valueSeries(values, windowDays(now, days), ownerId === ALL_OWNERS ? undefined : (id) => id === ownerId),
    [values, now, days, ownerId]
  )
  const change = windowChange(points)
  const high = points.reduce((m, p) => (p.total != null && p.total > m ? p.total : m), 0)
  const latest = points.findLast((p) => p.total != null)

  return (
    <>
      <div className={styles.header}>
        <h1>Assets</h1>
        <div className={styles.controls}>
          <label className={styles.filter}>
            Owner:&nbsp;
            <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
          </label>
          <WindowSelect days={days} onChange={setDays} />
        </div>
      </div>

      <section className={`${chart.panel} ${styles.valuation}`} aria-label="Total asset value over time">
        <div className={chart.panelHead}>
          <span className={chart.panelTitle}>Total value</span>
          <span>daily · Jita split on the day · utc</span>
          <span className={chart.spacer} />
          {latest?.total != null && (
            <>
              <span className={chart.faint}>now</span>
              <span className={chart.nowRate} title={formatIsk(latest.total)}>
                {formatCompactIsk(latest.total)}
              </span>
              <span className={chart.faint}>ISK</span>
            </>
          )}
        </div>
        {change == null ? (
          <p className={styles.valuationEmpty}>
            No valuation yet for this window. Each asset refresh stores the day&apos;s value, so the chart fills in from
            the next run.
          </p>
        ) : (
          <div className={chart.chartRow}>
            <ValueChart points={points} ownerName={ownerName} hover={hover} onHover={setHover} />
            <dl className={chart.summary} aria-label="Value over the window shown">
              <div>
                <dt>change</dt>
                <dd title={formatIsk(change.delta)}>
                  {change.delta >= 0 ? '+' : ''}
                  {formatCompactIsk(change.delta)} <span className={chart.summaryUnit}>ISK</span>
                </dd>
              </div>
              <div>
                <dt>change %</dt>
                <dd>{formatPct(change.pct)}</dd>
              </div>
              <div>
                <dt>high</dt>
                <dd title={formatIsk(high)}>
                  {formatCompactIsk(high)} <span className={chart.summaryUnit}>ISK</span>
                </dd>
              </div>
            </dl>
          </div>
        )}
        <div className={chart.panelFoot}>
          <span>each item at the Jita split in effect that day · blueprints and unpriced items left out</span>
        </div>
      </section>

      {children}

      <AssetsTable locations={locations} ownerId={ownerId} />
    </>
  )
}
