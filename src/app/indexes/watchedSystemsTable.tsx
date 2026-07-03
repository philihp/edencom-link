'use client'

import { useRef, useState, useTransition } from 'react'

import { formatIndex, INDEX_ACTIVITY_LABELS, type Activity, type IndexSeries } from '../structure/industryIndex'
import { Sparkline } from '../structure/sparkline'
import { reorderWatchedSystems, unwatchSystem } from './actions'
import styles from './indexes.module.css'

export type WatchedRow = {
  id: number
  name: string
  security: string | null
  cells: Array<{ activity: Activity; cost: number | null; series: IndexSeries | null }>
}

type WatchedSystemsTableProps = {
  columns: Activity[]
  rows: WatchedRow[]
}

// Renders the watch list and lets the user drag rows (via the grip handle) to
// reorder them. Dragging is initiated only from the grip — it's the drag
// source — so the delete button and the rest of the row stay ordinary click
// targets. `order` is optimistic local state so the row moves immediately;
// the actual reorder persists via reorderWatchedSystems() once the row is
// dropped, and the parent remounts this component (see the `key` in
// page.tsx) once the server confirms the new order.
export const WatchedSystemsTable = ({ columns, rows }: WatchedSystemsTableProps) => {
  const [order, setOrder] = useState(rows)
  const [, startTransition] = useTransition()
  const dragIndex = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const handleDrop = (index: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    setDragOverIndex(null)
    if (from === null || from === index) return
    setOrder((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(index, 0, moved)
      startTransition(() => {
        reorderWatchedSystems(next.map((r) => r.id))
      })
      return next
    })
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>System</th>
          {columns.map((activity) => (
            <th key={activity}>{INDEX_ACTIVITY_LABELS[activity]}</th>
          ))}
          <th />
        </tr>
      </thead>
      <tbody>
        {order.map((row, index) => (
          <tr
            key={row.id}
            onDragOver={(e) => {
              if (dragIndex.current === null) return
              e.preventDefault()
              if (dragOverIndex !== index) setDragOverIndex(index)
            }}
            onDragLeave={() => setDragOverIndex((current) => (current === index ? null : current))}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop(index)
            }}
            className={dragOverIndex === index ? styles.dragOver : undefined}
          >
            <td>
              <span className={styles.system}>{row.name}</span>{' '}
              {row.security && <span className={styles.security}>{row.security}</span>}
            </td>
            {row.cells.map(({ activity, cost, series }) => (
              <td key={activity}>
                {series || cost != null ? (
                  <span className={styles.cell}>
                    <Sparkline
                      values={series?.values ?? []}
                      liveCount={series?.liveCount}
                      updatedAt={series?.updatedAt}
                      label={`${row.name} ${INDEX_ACTIVITY_LABELS[activity]}`}
                    />
                    <span className={styles.current}>{cost != null ? formatIndex(cost) : '—'}</span>
                  </span>
                ) : (
                  <span className={styles.empty}>—</span>
                )}
              </td>
            ))}
            <td>
              <span className={styles.actions}>
                <form action={unwatchSystem}>
                  <input type="hidden" name="system_id" value={row.id} />
                  <button
                    type="submit"
                    className={styles.unwatch}
                    title={`Stop watching ${row.name}`}
                    aria-label={`Stop watching ${row.name}`}
                  >
                    ✕
                  </button>
                </form>
                <span
                  className={styles.grip}
                  draggable
                  onDragStart={(e) => {
                    dragIndex.current = index
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', String(index))
                  }}
                  onDragEnd={() => {
                    dragIndex.current = null
                    setDragOverIndex(null)
                  }}
                  title="Drag to reorder"
                  aria-label={`Drag to reorder ${row.name}`}
                >
                  ⠿
                </span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
