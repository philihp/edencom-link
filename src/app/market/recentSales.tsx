'use client'

import { DateTime } from '../DateTime'
import { formatMisk } from '../isk'
import styles from './market.module.css'
import { usePersist } from './usePersist'

export type Sale = {
  transaction_id: string | number
  character_id: string
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
  sales: Sale[]
  characters: Character[]
  typeNames: Record<number, string>
}

const THRESHOLDS: Array<{ label: string; value: number }> = [
  { label: 'All', value: 0 },
  { label: '≥ 1M ISK', value: 1_000_000 },
  { label: '≥ 10M ISK', value: 10_000_000 },
  { label: '≥ 100M ISK', value: 100_000_000 },
  { label: '≥ 1B ISK', value: 1_000_000_000 },
]

const THRESHOLD_STORAGE_KEY = 'market.recentSales.threshold'
const CHARACTER_STORAGE_KEY = 'market.recentSales.characterId'
const ALL_CHARACTERS = ''

export const RecentSales = ({ sales, characters, typeNames }: RecentSalesProps) => {
  const characterName: Record<string, string> = Object.fromEntries(characters.map((c) => [c.id, c.name]))

  const [threshold, setThreshold] = usePersist(THRESHOLD_STORAGE_KEY, 0, (raw) => {
    const parsed = Number(raw)
    return THRESHOLDS.some((t) => t.value === parsed) ? parsed : undefined
  })

  const [characterId, setCharacterId] = usePersist<string>(CHARACTER_STORAGE_KEY, ALL_CHARACTERS, (raw) =>
    raw === ALL_CHARACTERS || characters.some((c) => c.id === raw) ? raw : undefined
  )

  const filtered = sales.filter(
    (s) =>
      Number(s.unit_price) * Number(s.quantity) >= threshold &&
      (characterId === ALL_CHARACTERS || s.character_id === characterId)
  )

  return (
    <section>
      <div className={styles.salesHeader}>
        <h2>Recent Sales (last 7 days)</h2>
        <div className={styles.salesFilters}>
          <label className={styles.salesFilter}>
            Character:&nbsp;
            <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
              <option value={ALL_CHARACTERS}>All characters</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
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
              <th>Character</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th>Total</th>
              <th>Sold</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={`sale-${s.transaction_id}`}>
                <td className="serif">{characterName[s.character_id] ?? '—'}</td>
                <td className="serif">{typeNames[Number(s.type_id)] ?? `#${s.type_id}`}</td>
                <td>{s.quantity}</td>
                <td>{formatMisk(s.unit_price)}</td>
                <td>{formatMisk(Number(s.unit_price) * Number(s.quantity))}</td>
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
