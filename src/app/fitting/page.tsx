import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import type { FittingRow } from './fit'
import { buildMatrix, RACE_COLUMNS } from './shipMatrix'
import styles from './fittings.module.css'

// Every saved fitting the signed-in player can see, laid out the way ship
// charts are: one row per hull class (Frigate → Battleship → Capital), one
// column per empire ship line plus Faction — see shipMatrix.ts for the
// bucketing. RLS on character_fitting_over_time scopes the view to the
// caller's own registrations, so this select needs no owner filter of its own.
//
// These are the fittings each character has saved *personally* in the game
// client: ESI has no corporation or alliance fittings endpoint, so a doctrine
// fit only appears here if one of your characters saved a copy. See
// docs/fittings.md.
const FittingPage = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: fittings } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .returns<FittingRow[]>()
  const rows = fittings ?? []

  // One bulk SDE lookup carries everything the matrix buckets by: hull name,
  // group (→ class row), race and meta group (→ column).
  const types = await getSdeTypes(rows.map((f) => Number(f.ship_type_id)))
  const matrix = buildMatrix(rows, types)

  return (
    <>
      <h1>Fittings</h1>
      <p className={styles.intro}>
        Ship fittings saved in the game by your characters. EVE&rsquo;s API only exposes each pilot&rsquo;s{' '}
        <em>personal</em> fittings — a corporation or alliance doctrine fit shows up here only if one of your characters
        has saved their own copy of it.
      </p>

      {matrix.length === 0 ? (
        <p className={styles.empty}>
          No fittings yet. Add a character with the <code>esi-fittings.read_fittings.v1</code> scope on the{' '}
          <Link href="/account/settings">settings page</Link>, then refresh from{' '}
          <Link href="/character/refresh">the refresh page</Link>.
        </p>
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
                            <li key={`${f.characterId}:${f.fittingId}`}>
                              <Link href={`/fitting/${f.characterId}/${f.fittingId}`} className={styles.fitLink}>
                                {f.name}
                              </Link>
                              <span className={styles.fitHull}>{f.hull}</span>
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

export default FittingPage
