import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ascend, sortWith } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { Name } from '../names'
import { fetchTypeNames } from '../typeNames'
import type { FittingRow } from './fit'
import styles from './fittings.module.css'

// Every saved fitting the signed-in player can see. RLS on
// character_fitting_over_time scopes the view to the caller's own
// registrations, so this select needs no owner filter of its own.
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

  // Hull names from the SDE mirror, and character names for the owner column.
  const [typeNames, { data: registrations }] = await Promise.all([
    fetchTypeNames(rows.map((f) => Number(f.ship_type_id))),
    supabase.from('registration').select('id, name'),
  ])
  const characterName = new Map((registrations ?? []).map((r) => [r.id, r.name as string | null]))

  const hullOf = (row: FittingRow) => typeNames[Number(row.ship_type_id)] ?? `#${row.ship_type_id}`

  // Hull first, then the fit's own name — the order a player thinks of their
  // fittings in, and stable enough that the list doesn't reshuffle between runs.
  const sorted = sortWith<FittingRow>([ascend(hullOf), ascend((f) => (f.name ?? '').toLowerCase())], rows)

  return (
    <>
      <h1>Fittings</h1>
      <p className={styles.intro}>
        Ship fittings saved in the game by your characters. EVE&rsquo;s API only exposes each pilot&rsquo;s{' '}
        <em>personal</em> fittings — a corporation or alliance doctrine fit shows up here only if one of your characters
        has saved their own copy of it.
      </p>

      {sorted.length === 0 ? (
        <p className={styles.empty}>
          No fittings yet. Add a character with the <code>esi-fittings.read_fittings.v1</code> scope on the{' '}
          <Link href="/account/settings">settings page</Link>, then refresh from{' '}
          <Link href="/character/refresh">the refresh page</Link>.
        </p>
      ) : (
        <ul className={styles.grid}>
          {sorted.map((fit) => {
            const moduleCount = (fit.items ?? []).length
            return (
              <li key={`${fit.character_id}:${fit.fitting_id}`} className={styles.tile}>
                <div className={styles.head}>
                  <Link href={`/fitting/${fit.character_id}/${fit.fitting_id}`} className={styles.name}>
                    {fit.name || `Fitting #${fit.fitting_id}`}
                  </Link>
                </div>
                <p className={styles.hull}>
                  <Name name={hullOf(fit)} />
                </p>
                {fit.description ? <p className={styles.description}>{fit.description}</p> : null}
                <dl className={styles.fields}>
                  <dt className={styles.label}>Saved by</dt>
                  <dd className={styles.value}>
                    <Name name={characterName.get(fit.character_id) ?? null} />
                  </dd>
                  <dt className={styles.label}>Items</dt>
                  <dd className={`${styles.value} ${styles.num}`}>{moduleCount}</dd>
                </dl>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

export default FittingPage
