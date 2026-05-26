'use client'

import { useState } from 'react'
import styles from './character.module.css'
import { TypeName } from './typeName'

export type Sale = {
  transaction_id: string | number
  character_id: string
  date: string
  type_id: number | string
  quantity: number | string
  unit_price: number | string
  seen_at: string
}

type RecentSalesProps = {
  sales: Sale[]
  characterName: Record<string, string>
}

const THRESHOLDS: Array<{ label: string; value: number }> = [
  { label: 'All', value: 0 },
  { label: '≥ 1M ISK', value: 1_000_000 },
  { label: '≥ 10M ISK', value: 10_000_000 },
  { label: '≥ 100M ISK', value: 100_000_000 },
  { label: '≥ 1B ISK', value: 1_000_000_000 },
]

const formatIsk = (raw: string | number) => {
  const n = Number(raw)
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toPrecision(4)}b`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toPrecision(4)}m`
  if (abs >= 1_000) return `${(n / 1_000).toPrecision(4)}k`
  return n.toPrecision(4)
}

const formatDate = (iso: string) => new Date(iso).toLocaleString()

export const RecentSales = ({ sales, characterName }: RecentSalesProps) => {
  const [threshold, setThreshold] = useState(0)

  const filtered = sales.filter((s) => Number(s.unit_price) * Number(s.quantity) >= threshold)

  return (
    <section>
      <div className={styles.salesHeader}>
        <h2>Recent Sales (last 7 days)</h2>
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
                <td>{characterName[s.character_id] ?? '—'}</td>
                <td>
                  <TypeName typeID={Number(s.type_id)} />
                </td>
                <td>{s.quantity}</td>
                <td>{formatIsk(s.unit_price)}</td>
                <td>{formatIsk(Number(s.unit_price) * Number(s.quantity))}</td>
                <td>{formatDate(s.date)}</td>
                <td>{formatDate(s.seen_at)}</td>
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
