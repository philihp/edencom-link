'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { reduce } from 'ramda'

import { LinkSpinner } from '../linkSpinner'
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

type LocationRow = { loc: Location; count: number }
type SystemGroup = { system: string; rows: LocationRow[]; total: number }

// Assets are organized by solar system first, then the stations/structures
// within it. Rendering every location in one table got sluggish for accounts
// with hundreds of them, so the systems are paged client-side — the full
// owner-scoped set is already in memory (switching owners is instant, no round
// trip), so paging is just a slice. Paging is by system group so a system's
// locations never split across a page boundary.
const PAGE_SIZE = 25

export const AssetsTable = ({ locations, owners }: AssetsTableProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)
  const [page, setPage] = useState(0)

  const rows: LocationRow[] = locations
    .map((loc) => ({
      loc,
      count: ownerId === ALL_OWNERS ? Object.values(loc.counts).reduce((a, b) => a + b, 0) : (loc.counts[ownerId] ?? 0),
    }))
    .filter((row) => row.count > 0)

  // Group each location under its solar system (a location with no known system
  // — e.g. an unresolved structure — groups under its own name).
  const groups: SystemGroup[] = [
    ...reduce(
      (acc, row) => {
        const key = row.loc.system ?? row.loc.name
        const group = acc.get(key) ?? { system: key, rows: [], total: 0 }
        group.rows.push(row)
        group.total += row.count
        return acc.set(key, group)
      },
      new Map<string, SystemGroup>(),
      rows
    ).values(),
  ]
    // Busiest location first within a system, then by name for stability.
    .map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) => b.count - a.count || a.loc.name.localeCompare(b.loc.name)),
    }))
    // Busiest system first, then by name.
    .sort((a, b) => b.total - a.total || a.system.localeCompare(b.system))

  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
  // Switching owners reorders/shrinks the set, which can leave `page` past the
  // end — clamp rather than render a blank page.
  const currentPage = Math.min(page, pageCount - 1)
  const pageGroups = groups.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

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
      ) : groups.length > 0 ? (
        <>
          <table className={retro.retro}>
            <thead>
              <tr>
                <th>System</th>
                <th>Location</th>
                <th className={retro.num}>Items</th>
              </tr>
            </thead>
            {pageGroups.map((group) => (
              <tbody key={`system-${group.system}`}>
                <tr className={styles.systemRow}>
                  <th scope="rowgroup" colSpan={2} className="serif">
                    {group.system}
                  </th>
                  <td className={retro.num}>{group.total}</td>
                </tr>
                {group.rows.map(({ loc, count }) => (
                  <tr key={`location-${loc.id}`}>
                    <td aria-hidden="true" />
                    <td>
                      {/* Opening a busy hangar takes a moment; the spinner says
                          which row is being opened, which the whole-page
                          loading fallback can't. */}
                      <Link href={`/asset/${loc.id}`} className="serif">
                        {loc.name}
                        <LinkSpinner />
                      </Link>
                    </td>
                    <td className={retro.num}>{count}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {pageCount > 1 && (
            <div className={styles.pagination}>
              <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}>
                ‹ Prev
              </button>
              <span className={styles.pageStatus}>
                Page {currentPage + 1} of {pageCount} ({groups.length} systems)
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
