import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { fittingRoute, type FittingRow } from './fit'
import { buildMatrix, RACE_COLUMNS, type MatrixEntry } from './shipMatrix'
import styles from './fittings.module.css'

// Every saved fitting the signed-in player can see, laid out the way ship
// charts are: one row per hull class (Frigate → Battleship → Capital), one
// column per empire ship line plus Faction — see shipMatrix.ts for the
// bucketing.
//
// RLS on character_fitting_over_time scopes this to more than just the
// caller's own registrations now: a fit a corp- or alliance-mate shared (see
// character_fitting_share in schema.sql) is visible here too, since it's the
// same table and the same select. Entries not owned by one of the caller's
// own characters carry an `owner` label so the matrix stays honest about
// whose fit it's showing.
const FittingPage = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const [{ data: fittings }, { data: ownRegistrations }] = await Promise.all([
    supabase
      .from('character_fitting')
      .select('character_id, fitting_id, name, description, ship_type_id, items')
      .returns<FittingRow[]>(),
    supabase.from('registration').select('id'),
  ])
  const rows = fittings ?? []
  const ownIds = new Set((ownRegistrations ?? []).map((r) => r.id))

  // character_directory names only the fits shared in from elsewhere need —
  // the world-readable registration_id → name lookup (see
  // docs/sharing-layer/design.md), fetched just for those character_ids.
  const sharedInCharacterIds = [...new Set(rows.filter((f) => !ownIds.has(f.character_id)).map((f) => f.character_id))]
  const { data: directory } =
    sharedInCharacterIds.length > 0
      ? await supabase
          .from('character_directory')
          .select('registration_id, name')
          .in('registration_id', sharedInCharacterIds)
      : { data: [] as Array<{ registration_id: string; name: string | null }> }
  const ownerNameById = new Map((directory ?? []).map((d) => [d.registration_id, d.name]))

  const entries: MatrixEntry[] = rows.map((f) => ({
    href: fittingRoute(f.character_id, f.fitting_id),
    name: f.name || `Fitting #${f.fitting_id}`,
    shipTypeId: Number(f.ship_type_id),
    ...(ownIds.has(f.character_id) ? {} : { owner: ownerNameById.get(f.character_id) ?? 'unknown' }),
  }))

  // One bulk SDE lookup carries everything the matrix buckets by: hull name,
  // group (→ class row), race and meta group (→ column).
  const types = await getSdeTypes(entries.map((e) => e.shipTypeId))
  const matrix = buildMatrix(entries, types)

  return (
    <>
      <h1>Fittings</h1>
      <p className={styles.intro}>
        Ship fittings saved in the game by your characters, plus any a corp- or alliance-mate has shared with you.
        EVE&rsquo;s API only exposes each pilot&rsquo;s <em>personal</em> fittings, so a doctrine fit only shows up here
        if someone saved their own copy of it and shared that copy — see the share controls on a fit&rsquo;s own page.
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

export default FittingPage
