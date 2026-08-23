import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { formatBisk } from '../isk'
import { register } from './actions'
import { fetchCharacterOverviews, hasNoOptionalScopes } from './characterData'
import { JobSlots } from './jobSlotBubbles'
import styles from './character.module.css'

const CharacterPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const { characters, status, statusText, error } = await fetchCharacterOverviews(supabase)
  const noOptionalScopes = await hasNoOptionalScopes(supabase, user.id)

  return (
    <>
      <h1>Characters</h1>
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
      <ul className={styles.grid}>
        {characters.map((c) => (
          <li key={`character-${c.id}`} className={styles.tile}>
            {c.characterId ? (
              <img
                className={styles.avatar}
                src={`https://images.evetech.net/characters/${c.characterId}/portrait?size=128`}
                alt={c.name}
              />
            ) : (
              <div className={styles.avatar} aria-hidden="true" />
            )}
            <div className={styles.body}>
              <div className={styles.name}>{c.name}</div>
              {/* Only show the job-slot bubbles for characters who have shared their
                  skills — slots is null unless character_skill rows exist, so without
                  the scope we don't guess a capacity, we show nothing. */}
              {c.slots && <JobSlots counts={c.slots.counts} max={c.slots.max} />}
              <div className={styles.meta}>
                <span className={styles.metaLabel}>ISK:</span>
                {c.balance === null ? '—' : formatBisk(c.balance)}
              </div>
              <div className={styles.meta}>
                <span className={styles.metaLabel}>Location:</span>
                {c.locationSystem ?? '—'}
              </div>
              <div className={styles.meta}>
                <span className={styles.metaLabel}>Ship:</span>
                {c.ship ? <Link href={`/ship/${c.ship.itemId}`}>{c.ship.label}</Link> : '—'}
              </div>
              {c.cloneSystems.length > 0 && (
                <div className={styles.metaBlock}>
                  <span className={styles.metaLabel}>Clone systems:</span>
                  <ul className={`${styles.bulletList} ${styles.cloneList}`}>
                    {c.cloneSystems.map((system) => (
                      <li key={system}>{system}</li>
                    ))}
                  </ul>
                </div>
              )}
              {c.implants.length > 0 && (
                <div className={styles.metaBlock}>
                  <span className={styles.metaLabel}>Implants:</span>
                  <ul className={styles.bulletList}>
                    {c.implants.map((name: string, i: number) => (
                      <li key={i}>{name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
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
      <form className={styles.actions}>
        <button formAction={register}>Add Character</button>
      </form>
    </>
  )
}
export default CharacterPage
