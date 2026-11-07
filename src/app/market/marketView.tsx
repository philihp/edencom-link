'use client'

import { useMemo } from 'react'

import { isTimeWindowDays } from '../timeWindow'
import { usePersist } from '../usePersist'
import { WindowSelect } from '../windowSelect'
import { onSide } from './aggregate'
import { MarketOverview } from './marketOverview'
import { RecentTrades } from './recentTrades'
import { DEFAULT_SIDE, parseSide, SIDE_COPY, SIDE_STORAGE_KEY, SIDES } from './sides'
import type { Side, Trade } from './trade'
import { DEFAULT_WINDOW_DAYS, WINDOW_STORAGE_KEY } from './windows'
import styles from './market.module.css'

type Character = {
  id: string
  name: string
}

type MarketViewProps = {
  // Server-anchored "now" (ISO) so every window calculation is stable across the
  // SSR/hydration boundary instead of drifting with each client render.
  now: string
  // Buys and sells. The tab bar picks the side the page shows.
  trades: Trade[]
  characters: Character[]
  // corporation_id → name, for our corporation trades in the table.
  corpNames: Record<number, string>
  // client_id → name, for the counterparty of each trade. An id that
  // universe_name does not know yet is not in the record, and the page shows
  // the raw id.
  counterpartyNames: Record<number, string>
  typeNamesPromise: Promise<Record<number, string>>
}

// Owns the page-level time window and the active tab. The dropdown floats to
// the right of the "Market" title. The tab bar under the title picks sales or
// purchases. Both controls re-scope the overview tiles and the table below.
export const MarketView = ({
  now,
  trades,
  characters,
  corpNames,
  counterpartyNames,
  typeNamesPromise,
}: MarketViewProps) => {
  const nowMs = Date.parse(now)

  const [side, setSide] = usePersist<Side>(SIDE_STORAGE_KEY, DEFAULT_SIDE, parseSide)
  const onActiveSide = useMemo(() => onSide(side)(trades), [side, trades])

  const [windowDays, setWindowDays] = usePersist<number>(WINDOW_STORAGE_KEY, DEFAULT_WINDOW_DAYS, (raw) => {
    const parsed = Number(raw)
    return isTimeWindowDays(parsed) ? parsed : undefined
  })

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Market</h1>
        <WindowSelect days={windowDays} onChange={setWindowDays} />
      </div>
      <div role="tablist" aria-label="Trade side" className={styles.sideTabs}>
        {SIDES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={side === s ? `${styles.sideTab} ${styles.sideTabActive}` : styles.sideTab}
            onClick={() => setSide(s)}
          >
            {SIDE_COPY[s].tab}
          </button>
        ))}
      </div>
      <MarketOverview
        now={nowMs}
        side={side}
        trades={onActiveSide}
        windowDays={windowDays}
        typeNamesPromise={typeNamesPromise}
      />
      <RecentTrades
        key={side}
        now={nowMs}
        side={side}
        trades={onActiveSide}
        characters={characters}
        corpNames={corpNames}
        counterpartyNames={counterpartyNames}
        typeNamesPromise={typeNamesPromise}
        windowDays={windowDays}
      />
    </>
  )
}
