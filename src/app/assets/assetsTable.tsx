'use client'

import Link from 'next/link'

import retro from '../retro.module.css'
import styles from './assets.module.css'
import { ALL_CHARACTERS, CharacterFilter, useCharacterFilter, type Character } from './characterFilter'

export type Location = {
  id: string
  name: string
  system: string | null
  // character_id → number of item stacks that character has at this location.
  counts: Record<string, number>
}

type AssetsTableProps = {
  locations: Location[]
  characters: Character[]
}

export const AssetsTable = ({ locations, characters }: AssetsTableProps) => {
  const [characterId, setCharacterId] = useCharacterFilter(characters)

  const rows = locations
    .map((loc) => ({
      loc,
      count:
        characterId === ALL_CHARACTERS
          ? Object.values(loc.counts).reduce((a, b) => a + b, 0)
          : (loc.counts[characterId] ?? 0),
    }))
    .filter((row) => row.count > 0)
    // Busiest locations first, then by name for a stable order.
    .sort((a, b) => b.count - a.count || a.loc.name.localeCompare(b.loc.name))

  return (
    <section>
      <div className={styles.header}>
        <h1>Assets</h1>
        <CharacterFilter characters={characters} value={characterId} onChange={setCharacterId} />
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
                  <Link href={`/assets/${loc.id}`} className="serif">
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
        <p>No assets for this character.</p>
      )}
    </section>
  )
}
