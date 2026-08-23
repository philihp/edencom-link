// /registration — one page for the linked characters and the extract jobs that
// keep their data fresh (docs/registrations-page). Laid out per the phase-0
// design extraction: a page header over one bordered matrix, one row per
// registration.
//
// Phase 2 ships the shell and the character rows at parity with /character;
// the per-scope job columns, the axis refresh triggers and the poller land in
// phase 3. /character and /jobs stay live and unchanged until a separate
// sunset decision.
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { register } from '../character/actions'
import { fetchCharacterOverviews, hasNoOptionalScopes } from '../character/characterData'
import { JobSlots } from '../character/jobSlotBubbles'
import { formatBisk } from '../isk'
import styles from './registration.module.css'

// The phase-3 poller re-requests this server component while a kicked job is
// in flight, so never serve it from the router cache.
export const dynamic = 'force-dynamic'

const RegistrationPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const { characters, status, statusText, error } = await fetchCharacterOverviews(supabase)
  const noOptionalScopes = await hasNoOptionalScopes(supabase, user.id)

  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h1>Registrations &amp; refresh</h1>
          <div className={styles.status}>
            <span className={styles.statusCount}>{characters.length}</span>{' '}
            {characters.length === 1 ? 'character' : 'characters'}
          </div>
        </div>
        <form className={styles.headerActions}>
          <button formAction={register}>+ Register a character</button>
        </form>
      </div>

      {noOptionalScopes && (
        <div className={styles.warning} role="alert">
          <strong className={styles.warningTitle}>Limited access selected</strong>
          <p className={styles.warningBody}>
            You haven&apos;t enabled any ESI permissions, so characters you add will only be identified — no wallet,
            assets, industry, market, or structure data can be tracked. Choose what to share in{' '}
            <Link href="/settings/grants">settings</Link>.
          </p>
        </div>
      )}

      <div className={styles.matrix}>
        <div className={styles.headerRow}>
          <span className={styles.columnLabel}>Character</span>
          <span className={styles.columnLabel}>State</span>
        </div>

        {characters.length === 0 ? (
          <>
            {/* The empty state is the matrix, ghosted: one dashed row where the
                first character will appear, so the CTA doesn't have to explain
                what registering unlocks — the grid already does. */}
            <div className={styles.ghostRow} aria-hidden="true">
              <div className={styles.identity}>
                <div className={styles.ghostAvatar} />
                <div className={styles.ghostBar} />
              </div>
            </div>
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>No characters registered yet</div>
              <p className={styles.emptyBody}>
                Register one through EVE&apos;s SSO and this row fills in — refresh jobs start within a minute of the
                grant.
              </p>
              <form className={styles.emptyActions}>
                <button formAction={register}>Register your first character</button>
              </form>
              <div className={styles.reassurance}>
                Uses CCP&apos;s official login — we never see your password.{' '}
                <Link href="/settings/grants">What each scope unlocks</Link>
              </div>
            </div>
          </>
        ) : (
          characters.map((c) => (
            <div key={c.id} className={styles.row}>
              <div className={styles.identity}>
                {c.characterId ? (
                  <img
                    className={styles.avatar}
                    src={`https://images.evetech.net/characters/${c.characterId}/portrait?size=128`}
                    alt={c.name}
                  />
                ) : (
                  <div className={styles.avatar} aria-hidden="true" />
                )}
                <div className={styles.identityText}>
                  <div className={styles.name}>{c.name}</div>
                  {/* Only for characters who have shared their skills — slots is
                      null unless character_skill rows exist, so without the scope
                      we don't guess a capacity, we show nothing. */}
                  {c.slots && <JobSlots counts={c.slots.counts} max={c.slots.max} />}
                </div>
              </div>
              <div className={styles.state}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>ISK:</span>
                  {c.balance === null ? '—' : formatBisk(c.balance)}
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Location:</span>
                  {c.locationSystem ?? '—'}
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Ship:</span>
                  {c.ship ? <Link href={`/ship/${c.ship.itemId}`}>{c.ship.label}</Link> : '—'}
                </div>
                {c.cloneSystems.length > 0 && (
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Clone systems:</span>
                    <ul className={`${styles.list} ${styles.cloneList}`}>
                      {c.cloneSystems.map((system) => (
                        <li key={system}>{system}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {c.implants.length > 0 && (
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Implants:</span>
                    <ul className={styles.list}>
                      {c.implants.map((name: string, i: number) => (
                        <li key={i}>{name}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {error && (
        <>
          <strong>
            {status}: {statusText}
          </strong>
          <br />
          <em>
            {error.code}: {error.message}
          </em>
          <pre>{JSON.stringify(error, undefined, 2)}</pre>
        </>
      )}
    </>
  )
}
export default RegistrationPage
