'use client'

import { MarketOverview } from './marketOverview'
import { RecentSales, type Sale } from './recentSales'
import { usePersist } from './usePersist'
import { DEFAULT_WINDOW_DAYS, WINDOW_OPTIONS, WINDOW_STORAGE_KEY } from './windows'
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
  typeNamesPromise: Promise<Record<number, string>>
}

// Owns the page-level time window. The dropdown floats to the right of the
// "Market" title and re-scopes both the overview tiles and the Recent Sales
// table below.
export const MarketView = ({ now, sales, characters, typeNamesPromise }: MarketViewProps) => {
  const nowMs = Date.parse(now)

  const [windowDays, setWindowDays] = usePersist<number>(WINDOW_STORAGE_KEY, DEFAULT_WINDOW_DAYS, (raw) => {
    const parsed = Number(raw)
    return WINDOW_OPTIONS.some((o) => o.days === parsed) ? parsed : undefined
  })

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Market</h1>
        <label className={styles.windowSelect}>
          <span className={styles.srOnly}>Window</span>
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <MarketOverview now={nowMs} sales={sales} windowDays={windowDays} typeNamesPromise={typeNamesPromise} />
      <RecentSales
        now={nowMs}
        sales={sales}
        characters={characters}
        typeNamesPromise={typeNamesPromise}
        windowDays={windowDays}
      />
    </>
  )
}
