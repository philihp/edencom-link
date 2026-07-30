'use client'

import Link from 'next/link'

import type { SdeType } from '@/sdeTypes'
import { ALL_OWNERS, useOwnerFilter, type Owner } from '../ownerFilter'
import { OWNER_STORAGE_KEY } from './filterKey'
import { buildMatrix, RACE_COLUMNS, type MatrixEntry } from './shipMatrix'
import styles from './fittings.module.css'

// A fit plus the EVE character id of whoever saved it, so the owner filter
// selects on identity rather than a display name two pilots could share. The
// same id the fit's own href is built from.
export type FittingEntry = MatrixEntry & { ownerId: string }

type FittingMatrixProps = {
  entries: FittingEntry[]
  // Everything buildMatrix buckets by, resolved server-side in one bulk SDE
  // lookup and handed over as plain JSON.
  types: Record<number, SdeType>
  // The caller's own characters (every registration, even ones with no saved
  // fits — same as the assets owner select), and the characters whose fits
  // reached this page through a share.
  ownCharacters: Owner[]
  sharedCharacters: Owner[]
}

// The fitting library as a ship chart, with an owner filter over it.
//
// Client-side because the whole owner-scoped set is already in memory:
// switching characters is a re-bucket of entries we already hold, no round
// trip — the same reason /asset filters its location table in the browser.
export const FittingMatrix = ({ entries, types, ownCharacters, sharedCharacters }: FittingMatrixProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, {
    characters: [...ownCharacters, ...sharedCharacters],
    corporations: [],
  })

  const visible = ownerId === ALL_OWNERS ? entries : entries.filter((e) => e.ownerId === ownerId)
  // Bucketing after the filter, so a class row with nothing left in it stops
  // rendering rather than showing an all-empty strip.
  const matrix = buildMatrix(visible, types)

  return (
    <>
      <div className={styles.header}>
        <h1>Fittings</h1>
        <label className={styles.filter}>
          Owner:&nbsp;
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value={ALL_OWNERS}>All characters</option>
            <optgroup label="Your characters">
              {ownCharacters.map((c) => (
                <option key={`own-${c.id}`} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            {sharedCharacters.length > 0 && (
              <optgroup label="Shared with you">
                {sharedCharacters.map((c) => (
                  <option key={`shared-${c.id}`} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </div>

      <p className={styles.intro}>
        Ship fittings saved in the game by your characters, plus any another player has shared with you — with your
        corporation or alliance, or with everyone. EVE&rsquo;s API only exposes each pilot&rsquo;s <em>personal</em>{' '}
        fittings, so a doctrine fit only shows up here if someone saved their own copy of it and shared that copy — see
        the share controls on a fit&rsquo;s own page.
      </p>

      {entries.length === 0 ? (
        <p className={styles.empty}>
          No fittings yet. Add a character with the <code>esi-fittings.read_fittings.v1</code> scope on the{' '}
          <Link href="/account/settings">settings page</Link>, then refresh from{' '}
          <Link href="/character/refresh">the refresh page</Link>.
        </p>
      ) : matrix.length === 0 ? (
        <p className={styles.empty}>No fittings for this character.</p>
      ) : (
        <div className={styles.matrixScroll}>
          <table className={styles.matrix}>
            <thead>
              <tr>
                <th className={styles.classHeader} scope="col" aria-label="Ship class" />
                {RACE_COLUMNS.map((race) => (
                  <th key={race} scope="col">
                    {race}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.shipClass}>
                  <th className={styles.classHeader} scope="row">
                    {row.shipClass}
                  </th>
                  {RACE_COLUMNS.map((race) => (
                    <td key={race} className={styles.cell}>
                      {row.cells[race].length === 0 ? (
                        <span className={styles.cellEmpty}>—</span>
                      ) : (
                        <ul className={styles.cellFits}>
                          {row.cells[race].map((f) => (
                            <li key={f.href}>
                              <Link href={f.href} className={styles.fitLink}>
                                {f.name}
                              </Link>
                              <span className={styles.fitHull}>{f.hull}</span>
                              {f.owner ? <span className={styles.fitOwner}>shared by {f.owner}</span> : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
