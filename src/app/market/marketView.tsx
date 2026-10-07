'use client'

import { isTimeWindowDays } from '../timeWindow'
import { usePersist } from '../usePersist'
import { WindowSelect } from '../windowSelect'
import { MarketOverview } from './marketOverview'
import { RecentSales, type Sale } from './recentSales'
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
  sales: Sale[]
  characters: Character[]
  // corporation_id → name, for labelling corp sales in the Recent Sales table.
  corpNames: Record<number, string>
  typeNamesPromise: Promise<Record<number, string>>
}

// Owns the page-level time window. The dropdown floats to the right of the
// "Market" title and re-scopes both the overview tiles and the Recent Sales
// table below.
export const MarketView = ({ now, sales, characters, corpNames, typeNamesPromise }: MarketViewProps) => {
  const nowMs = Date.parse(now)

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
      <MarketOverview now={nowMs} sales={sales} windowDays={windowDays} typeNamesPromise={typeNamesPromise} />
      <RecentSales
        now={nowMs}
        sales={sales}
        characters={characters}
        corpNames={corpNames}
        typeNamesPromise={typeNamesPromise}
        windowDays={windowDays}
      />
    </>
  )
}
