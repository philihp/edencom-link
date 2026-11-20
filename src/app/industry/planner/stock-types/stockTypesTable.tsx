'use client'
// The stock directive as an editable table: one row per type, three quantity
// cells, a remove button, and the add box under it. Each cell is a native
// number input, so the arrow keys and the spinner step the quantity; a change
// saves on its own when the cell is left. The rows are server state — every
// write revalidates the page, and the parent remounts this table when the
// server's list changes (the `key` in page.tsx).
import { useState, useTransition } from 'react'

import { TypeIcon } from '../../../typeIcon'
import industryStyles from '../../industry.module.css'
import styles from '../planner.module.css'
import { AddType } from '../addType'
import { addTarget, removeTarget, setQuantity } from './actions'
import { QUANTITY_COLUMNS, type QuantityColumn, type StockTarget } from './stockTargets'

export type StockRow = StockTarget & { name: string; categoryID: number | null; price: number | null }

const COLUMN_LABEL: Record<QuantityColumn, string> = { backup: 'backup', home: 'home market', jita: 'jita market' }

const QuantityCell = ({ row, column }: { row: StockRow; column: QuantityColumn }) => {
  const [value, setValue] = useState(String(row[column]))
  const [bad, setBad] = useState(false)
  const [, startTransition] = useTransition()

  const save = () => {
    if (value === String(row[column])) return
    startTransition(async () => {
      const { ok } = await setQuantity(row.typeId, column, value)
      setBad(!ok)
    })
  }

  return (
    <td className={industryStyles.num}>
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value}
        aria-label={`${row.name} ${COLUMN_LABEL[column]}`}
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

export const StockTypesTable = ({ rows }: { rows: StockRow[] }) => {
  const [, startTransition] = useTransition()
  const listed = new Set(rows.map((r) => r.typeId))

  return (
    <>
      {rows.length > 0 ? (
        <div className={industryStyles.tableScroll}>
          <table className={industryStyles.table}>
            <thead>
              <tr>
                <th>type</th>
                {QUANTITY_COLUMNS.map((c) => (
                  <th key={c} className={industryStyles.num}>
                    {COLUMN_LABEL[c]}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.typeId} className={industryStyles.row}>
                  <td>
                    <span className={styles.typeCell}>
                      <TypeIcon id={row.typeId} size={20} categoryID={row.categoryID ?? undefined} />
                      {row.name}
                      {row.price === null && <span className={industryStyles.faint}> · unpriced</span>}
                    </span>
                  </td>
                  {QUANTITY_COLUMNS.map((c) => (
                    <QuantityCell key={c} row={row} column={c} />
                  ))}
                  <td>
                    <button
                      type="button"
                      className="quiet"
                      aria-label={`Remove ${row.name}`}
                      onClick={() => startTransition(() => removeTarget(row.typeId))}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.empty}>No stock types yet. Add one below.</p>
      )}
      <AddType listed={listed} onAdd={addTarget} />
    </>
  )
}
