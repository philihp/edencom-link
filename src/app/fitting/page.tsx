import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import type { FittingRow } from './fit'
import { ScopeToggles } from './scopeToggles'
import { buildMatrix, RACE_COLUMNS, type MatrixEntry } from './shipMatrix'
import styles from './fittings.module.css'

// A corp/alliance fit published on the site (see shared_fitting in
// schema.sql), as the matrix consumes it.
type SharedRow = {
  id: string
  audience: 'corporation' | 'alliance'
  name: string
  ship_type_id: number | string
}

// Every fitting the signed-in player can see, laid out the way ship charts
// are: one row per hull class (Frigate → Battleship → Capital), one column per
// empire ship line plus Faction — see shipMatrix.ts for the bucketing.
//
// Three sources, toggled by the Personal / Corp / Alliance checkboxes
// (?personal=0 etc turns one off): the character-fittings extract (each
// pilot's *personal* saved fits — ESI exposes nothing else, docs/fittings.md),
// and the corp/alliance fittings members have published on the site
// (shared_fitting — the doctrine folder ESI doesn't expose). RLS scopes all of
// it: personal fits to the caller's registrations, shared fits to corps and
// alliances the caller has a character in.
const FittingPage = async ({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) => {
  const params = await searchParams
  const showPersonal = params.personal !== '0'
  const showCorp = params.corp !== '0'
  const showAlliance = params.alliance !== '0'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const audiences = [...(showCorp ? ['corporation'] : []), ...(showAlliance ? ['alliance'] : [])]
  const [{ data: personal }, { data: shared }] = await Promise.all([
    showPersonal
      ? supabase
          .from('character_fitting')
          .select('character_id, fitting_id, name, description, ship_type_id, items')
          .returns<FittingRow[]>()
      : Promise.resolve({ data: [] as FittingRow[] }),
    audiences.length > 0
      ? supabase
          .from('shared_fitting')
          .select('id, audience, name, ship_type_id')
          .in('audience', audiences)
          .returns<SharedRow[]>()
      : Promise.resolve({ data: [] as SharedRow[] }),
  ])

  const entries: MatrixEntry[] = [
    ...(personal ?? []).map((f) => ({
      href: `/fitting/${f.character_id}/${f.fitting_id}`,
      name: f.name || `Fitting #${f.fitting_id}`,
      shipTypeId: Number(f.ship_type_id),
    })),
    ...(shared ?? []).map((f) => ({
      href: `/fitting/shared/${f.id}`,
      name: f.name,
      shipTypeId: Number(f.ship_type_id),
      badge: f.audience === 'corporation' ? 'Corp' : 'Alliance',
    })),
  ]

  // One bulk SDE lookup carries everything the matrix buckets by: hull name,
  // group (→ class row), race and meta group (→ column).
  const types = await getSdeTypes(entries.map((e) => e.shipTypeId))
  const matrix = buildMatrix(entries, types)

  return (
    <>
      <h1>Fittings</h1>
      <p className={styles.intro}>
        Ship fittings saved in the game by your characters, and the doctrine fits members have published to your
        corporation or alliance here. EVE&rsquo;s API only exposes each pilot&rsquo;s <em>personal</em> saved fittings —
        the in-game Corp and Alliance folders can&rsquo;t be read, so those columns hold what members publish from a
        fit&rsquo;s page instead.
      </p>

      <ScopeToggles />

      {matrix.length === 0 ? (
        <p className={styles.empty}>
          {showPersonal || showCorp || showAlliance ? (
            <>
              No fittings yet. Add a character with the <code>esi-fittings.read_fittings.v1</code> scope on the{' '}
              <Link href="/account/settings">settings page</Link>, then refresh from{' '}
              <Link href="/character/refresh">the refresh page</Link>.
            </>
          ) : (
            <>Everything is unchecked — pick at least one of Personal, Corp, or Alliance above.</>
          )}
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
                              <span className={styles.fitHull}>
                                {f.hull}
                                {f.badge ? <span className={styles.fitBadge}>{f.badge}</span> : null}
                              </span>
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
