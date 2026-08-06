'use client'

import Link from 'next/link'

import { LinkSpinner } from '../../linkSpinner'
import { ALL_OWNERS, OwnerSelect, useOwnerFilter, type Owners } from '../../ownerFilter'
import retro from '../../retro.module.css'
import styles from '../assets.module.css'
import type { Location } from '../assetsTable'
import { OWNER_STORAGE_KEY } from '../filterKey'

// The stations/structures within a solar system where the viewer holds assets —
// shown when a system id is opened directly. Items parked in a station live
// under the station's own id (location_id = station), not the system's, so they
// never surface in the system's own item listing; this directory bridges that,
// each row drilling into that location. Mirrors the index AssetsTable's owner
// filter + busiest-first ordering, scoped to one system (so no system grouping).
export const SystemLocations = ({ locations, owners }: { locations: Location[]; owners: Owners }) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)

  const rows = locations
    .map((loc) => ({
      loc,
      count: ownerId === ALL_OWNERS ? Object.values(loc.counts).reduce((a, b) => a + b, 0) : (loc.counts[ownerId] ?? 0),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.loc.name.localeCompare(b.loc.name))

  return (
    <section>
      <div className={styles.header}>
        <label className={styles.filter}>
          Owner:&nbsp;
          <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
        </label>
      </div>
      <table className={retro.retro}>
        <thead>
          <tr>
            <th>Location</th>
            <th className={retro.num}>Items</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ loc, count }) => (
            <tr key={`location-${loc.id}`}>
              <td>
                <Link href={`/asset/${loc.id}`} className="serif">
                  {loc.name}
                  <LinkSpinner />
                </Link>
              </td>
              <td className={retro.num}>{count}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={2}>No stations in this system for this owner.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
