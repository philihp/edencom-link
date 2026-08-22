'use client'

import { useState } from 'react'

import retro from '../retro.module.css'
import { TypeIcon } from '../typeIcon'
import styles from './bpos.module.css'
import { sortBpos, type BpoEntry, type SortKey } from './stack'

// The showcase table. Sorting is client-side state rather than a query param:
// the whole collection is already in memory, so reordering is instant, and the
// URL someone shares stays the clean one they were given.
export const BposTable = ({ entries }: { entries: BpoEntry[] }) => {
  const [sort, setSort] = useState<SortKey>('name')
  const rows = sortBpos(entries, sort)

  // A column header doubles as its sort control, the way the rest of the app
  // does its in-table affordances — a button, so it's reachable by keyboard.
  const SortHeader = ({ column, label }: { column: SortKey; label: string }) => (
    <th aria-sort={sort === column ? 'ascending' : 'none'}>
      <button
        type="button"
        className={sort === column ? `${styles.sortButton} ${styles.sorted}` : styles.sortButton}
        onClick={() => setSort(column)}
      >
        {label}
        {sort === column ? <span aria-hidden="true"> ▲</span> : null}
      </button>
    </th>
  )

  return (
    <table className={retro.retro}>
      <thead>
        <tr>
          <SortHeader column="name" label="Blueprint" />
          <SortHeader column="category" label="Category" />
          <th className={retro.num}>ME</th>
          <th className={retro.num}>TE</th>
          <th className={retro.num}>Qty</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <tr key={`${entry.typeId}|${entry.materialEfficiency}|${entry.timeEfficiency}`}>
            <td>
              <span className={styles.nameCell}>
                {/* Blueprints have no "icon" variation on CCP's image server —
                    an original answers to "bp". */}
                <TypeIcon id={entry.typeId} variation="bp" size={24} />
                <span className="serif">{entry.name ?? `#${entry.typeId}`}</span>
              </span>
            </td>
            <td className={entry.category ? undefined : retro.muted}>{entry.category ?? 'Uncategorized'}</td>
            <td className={retro.num}>{entry.materialEfficiency}</td>
            <td className={retro.num}>{entry.timeEfficiency}</td>
            <td className={retro.num}>{entry.quantity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
