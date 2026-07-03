'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { ALL_OWNERS, OwnerSelect, useOwnerFilter, type Owners } from '../ownerFilter'
import retro from '../retro.module.css'
import styles from './assets.module.css'
import { OWNER_STORAGE_KEY } from './filterKey'

export type Location = {
  id: string
  name: string
  system: string | null
  // owner id (character registration uuid or corporation id) → number of item
  // stacks that owner has at this location.
  counts: Record<string, number>
}

type AssetsTableProps = {
  locations: Location[]
  owners: Owners
}

// Rendering every location in one table got sluggish for accounts with
// hundreds of them, so the list is paged client-side — the full owner-scoped
// row set is already in memory (switching owners is instant, no round trip),
// so paging is just a slice.
const PAGE_SIZE = 50

export const AssetsTable = ({ locations, owners }: AssetsTableProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)
  const [page, setPage] = useState(0)

  const rows = locations
    .map((loc) => ({
      loc,
      count: ownerId === ALL_OWNERS ? Object.values(loc.counts).reduce((a, b) => a + b, 0) : (loc.counts[ownerId] ?? 0),
    }))
    .filter((row) => row.count > 0)
    // Busiest locations first, then by name for a stable order.
    .sort((a, b) => b.count - a.count || a.loc.name.localeCompare(b.loc.name))

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  // Switching owners reorders/shrinks the row set, which can leave `page`
  // past the end — clamp rather than render a blank page.
  const currentPage = Math.min(page, pageCount - 1)
  const pageRows = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

  // A new owner has its own busiest-first order, so always land back on page 1.
  useEffect(() => setPage(0), [ownerId])

  return (
    <section>
      <div className={styles.header}>
        <h1>Assets</h1>
        <label className={styles.filter}>
          Owner:&nbsp;
          <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
        </label>
      </div>
      {locations.length === 0 ? (
        <p>
          No assets visible. Link a character with the <code>esi-assets.read_assets.v1</code> scope on the{' '}
          <a href="/character">Characters</a> page so the hourly job can fetch them.
        </p>
      ) : rows.length > 0 ? (
        <>
          <table className={retro.retro}>
            <thead>
              <tr>
                <th>Location</th>
                <th>System</th>
                <th className={retro.num}>Items</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(({ loc, count }) => (
                <tr key={`location-${loc.id}`}>
                  <td>
                    <Link href={`/asset/${loc.id}`} className="serif">
                      {loc.name}
                    </Link>
                  </td>
                  <td className="serif">{loc.system && loc.system !== loc.name ? loc.system : '—'}</td>
                  <td className={retro.num}>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pageCount > 1 && (
            <div className={styles.pagination}>
              <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}>
                ‹ Prev
              </button>
              <span className={styles.pageStatus}>
                Page {currentPage + 1} of {pageCount} ({rows.length} locations)
              </span>
              <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}>
                Next ›
              </button>
            </div>
          )}
        </>
      ) : (
        <p>No assets for this owner.</p>
      )}
    </section>
  )
}
