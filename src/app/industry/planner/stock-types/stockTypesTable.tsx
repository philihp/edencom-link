'use client'
// The stock directive as an editable table: one row per type, three quantity
// cells, a remove button, and the add box under it. Each cell is a native
// number input, so the arrow keys and the spinner step the quantity; a change
// saves on its own when the cell is left. The rows are server state — every
// write revalidates the page, and the parent remounts this table when the
// server's list changes (the `key` in page.tsx).
import { useEffect, useRef, useState, useTransition } from 'react'

import { TypeIcon } from '../../../typeIcon'
import industryStyles from '../../industry.module.css'
import styles from '../planner.module.css'
import { addTarget, removeTarget, searchTypes, setQuantity } from './actions'
import { QUANTITY_COLUMNS, type QuantityColumn, type StockTarget } from './stockTargets'

const DEBOUNCE_MS = 300

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

const AddType = ({ listed }: { listed: ReadonlySet<number> }) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<[number, string][]>([])
  const [, startTransition] = useTransition()
  const latest = useRef('')

  useEffect(() => {
    const term = query.trim()
    latest.current = term
    if (term === '') {
      setResults([])
      return
    }
    const handle = window.setTimeout(() => {
      searchTypes(term).then((found) => {
        if (latest.current === term) setResults(found)
      })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query])

  const add = (typeId: number) => {
    setQuery('')
    setResults([])
    startTransition(() => addTarget(typeId))
  }

  return (
    <div className={styles.addBox}>
      <input
        type="search"
        value={query}
        placeholder="add an item type…"
        aria-label="Add an item type"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length > 0) {
            e.preventDefault()
            add(results[0][0])
          }
        }}
      />
      {results.length > 0 && (
        <ul className={styles.suggestions} role="listbox">
          {results.map(([typeId, name]) => (
            <li key={typeId}>
              <button type="button" className="quiet" disabled={listed.has(typeId)} onClick={() => add(typeId)}>
                <TypeIcon id={typeId} size={16} />
                {name}
                {listed.has(typeId) && <span className={industryStyles.faint}> · listed</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
      <AddType listed={listed} />
    </>
  )
}
