'use client'

import Link from 'next/link'

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

export const AssetsTable = ({ locations, owners }: AssetsTableProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)

  const rows = locations
    .map((loc) => ({
      loc,
      count: ownerId === ALL_OWNERS ? Object.values(loc.counts).reduce((a, b) => a + b, 0) : (loc.counts[ownerId] ?? 0),
    }))
    .filter((row) => row.count > 0)
    // Busiest locations first, then by name for a stable order.
    .sort((a, b) => b.count - a.count || a.loc.name.localeCompare(b.loc.name))

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
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Location</th>
              <th>System</th>
              <th className={retro.num}>Items</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ loc, count }) => (
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
      ) : (
        <p>No assets for this owner.</p>
      )}
    </section>
  )
}
