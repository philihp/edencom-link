'use client'
// The settings tab's two type lists: the manual build-or-buy choices and the
// manual stock counts. Each row saves on its own; the rows are server state,
// and the page remounts a list when the server's list changes (its `key`).
import { useState, useTransition } from 'react'

import { TypeIcon } from '../../../typeIcon'
import industryStyles from '../../industry.module.css'
import { AddType } from '../addType'
import styles from '../planner.module.css'
import { addBuildBuy, addManualStock, removeBuildBuy, removeManualStock, setBuildBuy, setManualStock } from './actions'
import { BUILD_BUY, type BuildBuy } from './settings'

type TypeRow = { typeId: number; name: string; categoryID: number | null }
export type BuildBuyRow = TypeRow & { choice: BuildBuy }
export type ManualStockRow = TypeRow & { quantity: number }

const TypeCell = ({ row }: { row: TypeRow }) => (
  <td>
    <span className={styles.typeCell}>
      <TypeIcon id={row.typeId} size={20} categoryID={row.categoryID ?? undefined} />
      {row.name}
    </span>
  </td>
)

const RemoveCell = ({ row, onRemove }: { row: TypeRow; onRemove: (typeId: number) => Promise<void> }) => {
  const [, startTransition] = useTransition()
  return (
    <td>
      <button
        type="button"
        className="quiet"
        aria-label={`Remove ${row.name}`}
        onClick={() => startTransition(() => onRemove(row.typeId))}
      >
        remove
      </button>
    </td>
  )
}

const ChoiceCell = ({ row }: { row: BuildBuyRow }) => {
  const [bad, setBad] = useState(false)
  const [, startTransition] = useTransition()
  return (
    <td>
      <select
        defaultValue={row.choice}
        aria-label={`${row.name}: build or buy`}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          const value = e.target.value
          startTransition(async () => setBad(!(await setBuildBuy(row.typeId, value)).ok))
        }}
      >
        {BUILD_BUY.map((c) => (
          <option key={c} value={c}>
            always {c}
          </option>
        ))}
      </select>
    </td>
  )
}

const CountCell = ({ row }: { row: ManualStockRow }) => {
  const [value, setValue] = useState(String(row.quantity))
  const [bad, setBad] = useState(false)
  const [, startTransition] = useTransition()
  const save = () => {
    if (value === String(row.quantity)) return
    startTransition(async () => setBad(!(await setManualStock(row.typeId, value)).ok))
  }
  return (
    <td className={industryStyles.num}>
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value}
        aria-label={`${row.name} count`}
        aria-invalid={bad || undefined}
        className={bad ? `${styles.quantity} ${styles.quantityBad}` : styles.quantity}
        onChange={(e) => {
          setBad(false)
          setValue(e.target.value)
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </td>
  )
}

export const BuildBuyList = ({ rows }: { rows: BuildBuyRow[] }) => (
  <>
    {rows.length > 0 ? (
      <div className={industryStyles.tableScroll}>
        <table className={industryStyles.table}>
          <thead>
            <tr>
              <th>type</th>
              <th>choice</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.typeId} className={industryStyles.row}>
                <TypeCell row={row} />
                <ChoiceCell row={row} />
                <RemoveCell row={row} onRemove={removeBuildBuy} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className={styles.empty}>No choices yet. The plan builds or buys each type by price.</p>
    )}
    <AddType listed={new Set(rows.map((r) => r.typeId))} onAdd={addBuildBuy} />
  </>
)

export const ManualStockList = ({ rows }: { rows: ManualStockRow[] }) => (
  <>
    {rows.length > 0 ? (
      <div className={industryStyles.tableScroll}>
        <table className={industryStyles.table}>
          <thead>
            <tr>
              <th>type</th>
              <th className={industryStyles.num}>count</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.typeId} className={industryStyles.row}>
                <TypeCell row={row} />
                <CountCell row={row} />
                <RemoveCell row={row} onRemove={removeManualStock} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className={styles.empty}>No manual stock. The plan counts only what the extracts see.</p>
    )}
    <AddType listed={new Set(rows.map((r) => r.typeId))} onAdd={addManualStock} />
  </>
)
