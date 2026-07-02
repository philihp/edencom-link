'use client'

import { DateTime } from '../DateTime'
import { formatMiskValue } from '../isk'
import { Name } from '../names'
import { TypeName } from '../typeName'
import styles from './market.module.css'
import { usePersist } from './usePersist'

export type Sale = {
  transaction_id: string | number
  // Personal sales carry the owning character; corp sales have no character and
  // carry a corporation_id instead.
  character_id: string | null
  corporation_id?: number | string | null
  date: string
  type_id: number | string
  quantity: number | string
  unit_price: number | string
  seen_at: string
}

type Character = {
  id: string
  name: string
}

type RecentSalesProps = {
  // Server-anchored "now" (epoch ms) shared with the overview, so the table and
  // the tiles cover exactly the same window.
  now: number
  sales: Sale[]
  characters: Character[]
  // corporation_id → name, for labelling corp sales (falls back to a raw id).
  corpNames: Record<number, string>
  typeNamesPromise: Promise<Record<number, string>>
  windowDays: number
}

const CORP_PREFIX = 'corp:'

const DAY_MS = 24 * 60 * 60 * 1000

const THRESHOLDS: Array<{ label: string; value: number }> = [
  { label: 'All', value: 0 },
  { label: '≥ 1M ISK', value: 1_000_000 },
  { label: '≥ 10M ISK', value: 10_000_000 },
  { label: '≥ 100M ISK', value: 100_000_000 },
  { label: '≥ 1B ISK', value: 1_000_000_000 },
]

const THRESHOLD_STORAGE_KEY = 'market.recentSales.threshold'
const SELLER_STORAGE_KEY = 'market.recentSales.characterId'
const ALL_SELLERS = ''

export const RecentSales = ({ now, sales, characters, corpNames, typeNamesPromise, windowDays }: RecentSalesProps) => {
  const characterName: Record<string, string> = Object.fromEntries(characters.map((c) => [c.id, c.name]))
  const windowStart = now - windowDays * DAY_MS
  const windowLabel = `${windowDays} day${windowDays === 1 ? '' : 's'}`

  // Corporations that actually appear in the sales, for the seller filter.
  const corpName = (id: number) => corpNames[id] ?? `Corp #${id}`
  const corpIds = [...new Set(sales.filter((s) => s.corporation_id != null).map((s) => Number(s.corporation_id)))].sort(
    (a, b) => corpName(a).localeCompare(corpName(b))
  )

  const sellerLabel = (s: Sale): string | null => {
    if (s.character_id) return characterName[s.character_id] ?? null
    if (s.corporation_id != null) return corpName(Number(s.corporation_id))
    return null
  }

  const [threshold, setThreshold] = usePersist(THRESHOLD_STORAGE_KEY, 0, (raw) => {
    const parsed = Number(raw)
    return THRESHOLDS.some((t) => t.value === parsed) ? parsed : undefined
  })

  const [sellerId, setSellerId] = usePersist<string>(SELLER_STORAGE_KEY, ALL_SELLERS, (raw) => {
    if (raw === ALL_SELLERS || characters.some((c) => c.id === raw)) return raw
    if (raw.startsWith(CORP_PREFIX) && corpIds.includes(Number(raw.slice(CORP_PREFIX.length)))) return raw
    return undefined
  })

  const matchesSeller = (s: Sale) => {
    if (sellerId === ALL_SELLERS) return true
    if (sellerId.startsWith(CORP_PREFIX)) return String(s.corporation_id ?? '') === sellerId.slice(CORP_PREFIX.length)
    return s.character_id === sellerId
  }

  const filtered = sales.filter(
    (s) =>
      Date.parse(s.date) >= windowStart && Number(s.unit_price) * Number(s.quantity) >= threshold && matchesSeller(s)
  )

  return (
    <section>
      <div className={styles.salesHeader}>
        <h2>Recent Sales (last {windowLabel})</h2>
        <div className={styles.salesFilters}>
          <label className={styles.salesFilter}>
            Seller:&nbsp;
            <select value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
              <option value={ALL_SELLERS}>All sellers</option>
              <optgroup label="Characters">
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
              {corpIds.length > 0 && (
                <optgroup label="Corporations">
                  {corpIds.map((id) => (
                    <option key={id} value={`${CORP_PREFIX}${id}`}>
                      {corpName(id)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label className={styles.salesFilter}>
            Filter:&nbsp;
            <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
              {THRESHOLDS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {filtered.length > 0 ? (
        <table className={styles.sales}>
          <thead>
            <tr>
              <th>Seller</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Unit (mISK)</th>
              <th>Total (mISK)</th>
              <th>Sold</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={`sale-${s.transaction_id}`}>
                <td>
                  <Name name={sellerLabel(s)} />
                </td>
                <td>
                  <TypeName id={Number(s.type_id)} promise={typeNamesPromise} />
                </td>
                <td>{s.quantity}</td>
                <td>{formatMiskValue(s.unit_price)}</td>
                <td>{formatMiskValue(Number(s.unit_price) * Number(s.quantity))}</td>
                <td>
                  <DateTime value={s.date} />
                </td>
                <td>
                  <DateTime value={s.seen_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No sales matching this filter.</p>
      )}
    </section>
  )
}
